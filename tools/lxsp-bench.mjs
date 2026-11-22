/**
 * 延迟基准：量四个通道的「探测」和「取直链」耗时（含缓存命中）。
 *
 * 用法：node --import ./tests/lxsp/hook.mjs tools/lxsp-bench.mjs [API_URL] [API_KEY]
 */
import { detectEndpoint } from '../src/core/source/detect.ts'
import { SourceEngine } from '../src/core/source/engine.ts'

const base = process.argv[2] || 'http://127.0.0.1:1101'
const key = process.argv[3] || 'Cyb-P2077-n30h4ck3r-0X'

const ms = (n) => `${String(Math.round(n)).padStart(6)}ms`

const time = async(label, fn) => {
  const t0 = Date.now()
  try {
    const value = await fn()
    console.log(`${label.padEnd(30)} ${ms(Date.now() - t0)}`)
    return value
  } catch (error) {
    console.log(`${label.padEnd(30)} ${ms(Date.now() - t0)}  ✗ ${error.code ?? ''} ${String(error.message).slice(0, 60)}`)
    return null
  }
}

const main = async() => {
  console.log(`端点: ${base}\n`)

  await time('探测·冷启动 #1', () => detectEndpoint({ baseUrl: base, token: key || null, fetchImpl: fetch }))
  await time('探测·冷启动 #2', () => detectEndpoint({ baseUrl: base, token: key || null, fetchImpl: fetch }))

  const engine = new SourceEngine()
  await time('引擎 init（含探测+注册）', () => engine.init({ endpoints: [{ baseUrl: base, token: key || null }] }))
  await time('引擎 init·再来一次（缓存）', () => engine.init({ endpoints: [{ baseUrl: base, token: key || null }] }))

  const source = 'kw'
  const id = '62355680'
  await time('取直链·首次', () => engine.apis(source).getMusicUrl({ songmid: id }, '320k').promise)
  await time('取直链·重复（直链缓存）', () => engine.apis(source).getMusicUrl({ songmid: id }, '320k').promise)
  await time('取直链·并发 3 次（单飞）', () => Promise.all([1, 2, 3].map(() => engine.apis(source).getMusicUrl({ songmid: id }, '320k').promise)))
}

main().catch((error) => { console.error('基准失败:', error.message); process.exitCode = 1 })
