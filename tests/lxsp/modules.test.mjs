/**
 * 模块解析死区修复：把「一起听 + 原生桥 + 播放器钩子 + 面板」全部真实解析一遍。
 *
 * 为什么需要这个：之前的 99 项测试从来不解析这些文件，
 * 所以哪怕里面出现语法错误，测试仍会全绿——这就是覆盖死区。
 * 现在每个文件都必须能被 babel（TS+JSX）解析；可导入的还要真的导入一次（验证 import 图）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = new URL('../../', import.meta.url)
const root = fileURLToPath(repo)
const { createRequire } = await import('node:module')
const parserModule = (() => {
  // 仓库内（CI 装了 metro/babel 依赖）→ @babel/parser 可用；本地没有 npm 时用辅助目录
  for (const base of [import.meta.url, `${process.env.HOME}/parsecheck/package.json`]) {
    try {
      const requireFrom = createRequire(base)
      return requireFrom('@babel/parser')
    } catch (error) { /* 下一个 */ }
  }
  return null
})()

// 2026-11-27：原来只解析 2 个目录 + 2 个文件（约 30 个），其余 570+ 个 .ts/.tsx 全是死区——
// 这也是为什么 src/utils/nativeModules/authz.ts 里的 `<T>(..)` 歧义能一直没被发现。
// 现在全量解析 src，覆盖率和「被改过的文件」自然对齐。
const DIRS = ['src']
const EXTRA = []
/** 低于这个数量说明 walk 出问题了（宁可红，也别静默少覆盖） */
const MIN_FILES = 550

const walk = (dir, out = []) => {
  let entries = []
  try { entries = readdirSync(join(root, dir)) } catch (error) { return out }
  for (const name of entries) {
    const rel = join(dir, name)
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
  }
  return out
}

export default (t) => {
  const files = [...DIRS.flatMap((dir) => walk(dir)), ...EXTRA]

  t.suite('模块解析：src 下每个 .ts/.tsx 都必须能通过语法解析（含 .tsx）', () => {
    t.ok(parserModule != null, '必须能加载 @babel/parser（否则这条测试等于没跑）')
    const parser = parserModule
    t.ok(files.length >= MIN_FILES, `至少覆盖 ${MIN_FILES} 个文件，实际 ${files.length}`)
    const failures = []
    for (const rel of files) {
      const code = readFileSync(join(root, rel), 'utf8')
      try {
        parser.parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
      } catch (error) {
        failures.push(`${rel}: ${error.message}`)
      }
    }
    t.eq(failures, [], `语法解析失败：\n${failures.join('\n')}`)
  })

  t.suite('模块解析：p2p 桥的错误上报必须真的存在', () => {
    const p2p = readFileSync(join(root, 'src/utils/nativeModules/p2p.ts'), 'utf8')
    const count = (p2p.match(/reportError\(/g) || []).length
    t.ok(count > 0, `p2p.ts 里 reportError 调用数必须 >0，实际 ${count}`)
    t.ok(p2p.includes("import { reportError }"), 'p2p.ts 必须 import reportError')
  })

  t.suite('模块解析：错误通道模块可被导入', async() => {
    const mod = await import(fileURLToPath(new URL('../../src/core/listen-together/errors.ts', import.meta.url)))
    mod.reportError('selftest', new Error('expected'))
    t.ok(mod.recentErrors().some((item) => item.scope === 'selftest'), '上报后能在环形缓冲里查到')
  })
}
