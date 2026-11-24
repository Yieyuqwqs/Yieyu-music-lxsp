/**
 * 分支审计进 CI：硬违规必须为 0。
 *
 * 这里不是"禁止 if"——那在语法上不可能（没有条件分支就没有状态机/边界校验）。
 * 这里禁止的是**伪装成修复的写法**：吞异常、catch 里静默返回、用魔法阈值绕过时序。
 */
import { execFileSync } from 'node:child_process'

export default (t) => {
  t.suite('分支审计：零硬违规（无吞异常）', () => {
    let output = ''
    let failed = false
    try {
      output = execFileSync(process.execPath, ['tools/if-audit.mjs'], { encoding: 'utf8' })
    } catch (error) {
      failed = true
      output = String(error.stdout || '')
    }
    t.ok(!failed, `审计器应通过；实际输出：\n${output.split('\n').slice(-6).join('\n')}`)
    t.ok(output.includes('硬违规：0'), '硬违规数必须为 0')
    t.ok(/if 共 \d+ 处/.test(output), '必须输出分支清单统计')
  })
}
