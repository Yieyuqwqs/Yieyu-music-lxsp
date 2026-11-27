/**
 * 构建配置：生产包裁剪 console（保留 warn/error）+ 恢复播放尊重「启动自动播放」
 *
 * 为什么值得测：
 *   · console 裁剪是 Babel 插件，写错会把 `const x = console.log()` 这种语义改掉 —— 必须逐类验证；
 *   · 恢复播放的 pause/play 分支以前是"永远 pause 再靠定时器兜回来"，顺序一变就等于设置失效。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const exists = (rel) => existsSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)))

/** 最小假的 Babel path：插件只需要 node.expression 与 remove() */
const makePath = (expression) => {
  const removed = []
  return {
    removed,
    path: { node: { type: 'ExpressionStatement', expression }, remove: () => removed.push(true) },
  }
}
const callExpr = (object, property) => ({
  type: 'CallExpression',
  callee: { type: 'MemberExpression', object: { type: 'Identifier', name: object }, property: { type: 'Identifier', name: property } },
  arguments: [],
})

export default (t) => {
  t.suite('构建配置：console 裁剪只删 log/info/debug/trace，保留 warn/error', async() => {
    const mod = await import('../../plugins/strip-console.cjs')
    const plugin = mod.default ?? mod
    t.eq(typeof plugin, 'function', '插件必须导出函数')
    const visitor = plugin().visitor.ExpressionStatement

    for (const method of ['log', 'info', 'debug', 'trace']) {
      const { removed, path } = makePath(callExpr('console', method))
      visitor(path)
      t.eq(removed.length, 1, `console.${method} 必须被删掉`)
    }
    for (const method of ['warn', 'error']) {
      const { removed, path } = makePath(callExpr('console', method))
      visitor(path)
      t.eq(removed.length, 0, `console.${method} 必须保留（报错要能定位）`)
    }
    // 不是 console 对象 / 不是调用语句 → 一律不动
    const other = makePath(callExpr('global', 'log'))
    visitor(other.path)
    t.eq(other.removed.length, 0, '别的对象的 .log 不许动')

    const variable = makePath({ type: 'MemberExpression' })
    visitor(variable.path)
    t.eq(variable.removed.length, 0, '非调用表达式不许动')
  })

  t.suite('构建配置：release 启用裁剪、dev 不启用', async() => {
    t.ok(exists('plugins/strip-console.cjs'), '插件文件必须存在')
    const mod = await import('../../babel.config.js')
    const config = mod.default ?? mod
    t.ok(exists('babel.config.js'), 'babel 配置必须存在')

    const build = (isDev) => config({ cache: () => {}, caller: (fn) => fn({ isDev }) })
    const dev = build(true)
    const release = build(false)
    t.ok(!dev.plugins.some(p => typeof p === 'function'), 'dev 构建不许裁 console（调试要看日志）')
    t.ok(release.plugins.some(p => typeof p === 'function'), 'release 构建必须挂上裁剪插件')
    const last = release.plugins[release.plugins.length - 1]
    t.ok(typeof last === 'string' && last.includes('reanimated'), `reanimated 插件必须仍在链尾，实际 ${String(last)}`)
  })

  t.suite('恢复播放：启动自动播放必须在 pause/play 分支里说了算', () => {
    const code = read('src/plugins/player/playList.ts')
    t.ok(code.includes("settingState.setting['player.startupAutoPlay']"), '必须读取 startupAutoPlay 设置')
    t.ok(/startupAutoPlay\) await TrackPlayer\.play\(\)/.test(code), '开了就必须 play')
    t.ok(/else await TrackPlayer\.pause\(\)/.test(code), '关了就必须 pause')
    t.ok(!code.includes('已知限制 2'), '这条已知限制已经修掉，注释不许再留')
    const defaults = read('src/config/defaultSetting.ts')
    t.ok(/'player\.startupAutoPlay': false/.test(defaults), '默认关闭（不改变既有用户行为）')
  })
}
