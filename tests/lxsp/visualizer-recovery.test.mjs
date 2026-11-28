/**
 * 可视化「卡一下就没了」的回归测试
 *
 * 根因（两处，都在 PlayerVisualizer 里）：
 *   1. `await getVisualizer()` 没有超时 —— 原生卡住时整个取帧循环永久挂死；
 *   2. 柱子高度靠 setNativeProps 写原生，但 JSX 里是 height:0：
 *      卡顿后父组件重渲染会把高度重置为 0，而循环的 applied 差分表以为"已经贴过"，不再重贴。
 *
 * 这里用可单测的纯函数 + 结构契约把两条都钉住（React 组件本身没法在 node 里渲染）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { raceTimeout } from '../../src/utils/raceTimeout.ts'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export default (t) => {
  t.suite('可视化：取帧必须有超时，原生卡死不能拖死循环', async() => {
    t.eq(await raceTimeout(Promise.resolve(42), 100, null), 42, '正常返回要拿到值')
    const startedAt = Date.now()
    const hung = new Promise(() => {}) // 永不 settle：模拟原生卡住
    const value = await raceTimeout(hung, 80, null)
    const elapsed = Date.now() - startedAt
    t.eq(value, null, '悬挂的 Promise 必须返回 fallback')
    t.ok(elapsed >= 70 && elapsed < 500, `必须按超时返回（实测 ${elapsed}ms）`)
    t.eq(await raceTimeout(Promise.reject(new Error('boom')), 100, 'fallback'), 'fallback', 'reject 也要降级成 fallback')
    await sleep(1)
  })

  t.suite('可视化：重渲染后必须把柱子高度重新贴回去', () => {
    const code = read('src/components/PlayerVisualizer.tsx')
    t.ok(code.includes('raceTimeout('), '取帧必须经过 raceTimeout（否则循环会挂死）')
    t.ok(/FRAME_TIMEOUT_MS\s*=\s*\d+/.test(code), '必须有明确的取帧超时常量')
    t.ok(code.includes('setVisualizerEnabled(true)'), '长时间取不到数据要重新打开原生采集')
    // 重贴高度的 effect：没有依赖数组（每次渲染后都跑）
    const effectMatch = /useEffect\(\(\) => \{[\s\S]{0,400}?refs\[i\]\?\.setNativeProps\(\{ style: \{ height: heights\[i\] \} \}\)[\s\S]{0,120}?\}\)\n/.exec(code)
    t.ok(!!effectMatch, '必须有一个「每次渲染后重贴高度」的 effect')
    t.ok(/applied\[i\] = heights\[i\]/.test(code), '重贴后要同步差分表，否则循环仍会跳过这些柱子')
  })
}
