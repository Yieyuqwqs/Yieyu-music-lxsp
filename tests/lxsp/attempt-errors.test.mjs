/**
 * 换源失败汇总：原因必须活到 UI，而不是只活在 logcat 里
 *
 * 回归的是这个 bug：三条换源链路全部失败时只抛一句「换源失败」，
 * 真实原因（unauthorized / upstream_denied / timeout）被 console.log 吃掉。
 */
import { AllSourcesFailedError, describeAttempts, toAttemptFailure, throwAttempts } from '../../src/utils/attemptErrors.ts'

export default (t) => {
  t.suite('换源失败：摘要要去重、带音源与错误码', () => {
    const attempts = [
      { source: 'kg', code: 'upstream_denied', message: '版权限制' },
      { source: 'kg', code: 'upstream_denied', message: '版权限制' },
      { source: 'wy', code: 'timeout', message: '超时 12000ms' },
    ]
    const text = describeAttempts(attempts)
    t.eq(text, 'kg:upstream_denied 版权限制 / wy:timeout 超时 12000ms', `实际：${text}`)
    t.ok(!text.includes('版权限制 / kg'), '重复的失败不许重复展示')
  })

  t.suite('换源失败：摘要限量、且不出现 undefined/换行', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ source: `s${i}`, code: 'network', message: '断网\n换行' }))
    const text = describeAttempts(many)
    t.ok(text.split(' / ').length <= 5, `最多 5 条，实际 ${text.split(' / ').length}`)
    t.ok(!text.includes('\n'), '摘要必须是单行（状态栏直接用）')
    t.eq(describeAttempts([]), 'unknown', '空列表要有兜底文案')
  })

  t.suite('换源失败：错误对象带结构化 attempts 且 message 可读', () => {
    const error = new AllSourcesFailedError('换源失败', [
      { source: 'kg', code: 'upstream_denied', message: '版权限制' },
      { source: 'wy', message: '接口没有返回直链' },
    ])
    t.ok(error instanceof Error, '必须是 Error 实例')
    t.eq(error.code, 'all_sources_failed', '必须带稳定错误码')
    t.eq(error.attempts.length, 2, 'attempts 必须完整保留')
    t.eq(error.message, '换源失败：kg:upstream_denied 版权限制 / wy:接口没有返回直链', `实际：${error.message}`)
  })

  t.suite('换源失败：单条失败走原样抛出（tooManyRequests 等特判不能被破坏）', () => {
    const original = new Error('too many requests')
    let caught = null
    try { throwAttempts('换源失败', [{ source: 'kg', message: 'too many requests' }], original) } catch (error) { caught = error }
    t.eq(caught, original, '只有一条失败时必须原样抛回原错误对象')

    let multi = null
    try {
      throwAttempts('换源失败', [
        { source: 'kg', code: 'upstream_denied', message: '版权' },
        { source: 'wy', code: 'timeout', message: '超时' },
      ], original)
    } catch (error) { multi = error }
    t.ok(multi instanceof AllSourcesFailedError, '多条失败必须包装成汇总错误')
  })

  t.suite('换源失败：任意抛出物都能归一（字符串 / 空对象 / 带 code）', () => {
    t.eq(toAttemptFailure('kg', 'plain text'), { source: 'kg', code: undefined, message: 'plain text' }, '字符串要保留原文')
    t.eq(toAttemptFailure('kg', { code: 'unauthorized', message: '密钥无效' }), { source: 'kg', code: 'unauthorized', message: '密钥无效' })
    t.eq(toAttemptFailure('kg', undefined).message, 'unknown', '空抛出物要有兜底')
    t.eq(toAttemptFailure('kg', { code: '' }).code, undefined, '空字符串错误码要视为没有')
  })
}

/**
 * 结构契约：失败原因不许再被 console.log 吞掉
 *
 * 这几条是"静态契约"而不是行为测试（这三个模块依赖 RN 存储/音乐 SDK，node 里跑不起来），
 * 作用是防止有人把 `console.log(err)` 那套写法加回来。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

export const swallowSuite = (t) => {
  t.suite('结构契约：三条换源链路都必须记录原因并汇总抛出', () => {
    const code = read('src/core/music/utils.ts')
    t.ok(!/console\.log\(err\)/.test(code), '换源失败不许再只 console.log(err)')
    const recordCount = (code.match(/toAttemptFailure\(/g) || []).length
    t.ok(recordCount >= 4, `至少 4 处记录失败原因（三条链 + 首错），实际 ${recordCount}`)
    const throwCount = (code.match(/throwAttempts\(/g) || []).length
    t.ok(throwCount >= 3, `三条链都要在穷尽后汇总抛出，实际 ${throwCount}`)
    t.ok(code.includes("attempts: [firstFailure]"), '首错必须作为 attempts 传给后续换源')
  })

  t.suite('结构契约：多源搜索全挂必须报错，不许返回空列表', () => {
    const code = read('src/core/search/music.ts')
    t.ok(code.includes('AllSourcesFailedError'), '必须用汇总错误')
    t.ok(/okCount === 0/.test(code), '必须有"全部失败"的判定')
    t.ok(!/console\.log\(error\)/.test(code), '多源搜索的失败不许只 console.log')
  })

  t.suite('结构契约：下载目录回退必须可见（不再静默降级）', () => {
    const core = read('src/core/download/index.ts')
    t.ok(core.includes('getSaveDirNotice'), '必须导出回退原因')
    t.ok(/saveDirNotice = failures\.length/.test(core), '回退时必须记录原因')
    t.ok(/return \{ ok: false, reason:/.test(core), '目录不可写必须带原因返回')
    t.ok(core.includes('const ensureDir = async(dir: string): Promise<string>'), 'ensureDir 必须把失败原因返回给调用方，而不是 catch 掉')
    t.ok(core.includes('if (mkdirError) throw new Error(`创建下载目录失败：${mkdirError}`)'), '按歌手分目录失败时必须抛出真实原因')
    const screen = read('src/screens/Home/Views/Download/index.tsx')
    t.ok(screen.includes('getSaveDirNotice()'), '下载页必须把回退原因显示出来')
  })

  t.suite('结构契约：同步鉴权的 JSON 解析不许裸奔', () => {
    const code = read('src/plugins/sync/client/auth.ts')
    t.ok(code.includes('codeAuth parseMsg error'), '解析失败必须走降级路径并记日志')
    t.ok(!/const info = JSON\.parse\(msg\) as LX\.Sync\.KeyInfo/.test(code), '不许再裸 JSON.parse')
  })
}
