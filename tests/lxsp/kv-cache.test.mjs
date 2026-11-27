/**
 * 有界缓存：淘汰必须按 LRU，且淘汰永远不影响正确性
 *
 * 背景：storage 的内存缓存原来是裸 Map（无上限），歌单越大常驻内存越多。
 * 这里既测"会不会淘汰"，也测"淘汰了还能不能读对"——后者才是真正的风险点。
 */
import { BoundedKvCache } from '../../src/plugins/kv-cache.ts'
import { saveData, getData } from '../../src/plugins/storage.ts'
import { __resetAsyncStorage } from './stubs/async-storage.mjs'
import { __resetNativeKv } from './stubs/react-native.mjs'

export default (t) => {
  t.suite('有界缓存：条数上限与 LRU 淘汰', () => {
    const cache = new BoundedKvCache({ maxEntries: 3, maxBytes: 10_000 })
    cache.set('a', '1')
    cache.set('b', '2')
    cache.set('c', '3')
    t.eq(cache.size, 3, '三条都在')
    cache.get('a')            // 触摸 a → b 变成最旧
    cache.set('d', '4')       // 触发淘汰
    t.eq(cache.size, 3, '条数不得超过上限')
    t.eq(cache.get('b'), undefined, '最久未用的 b 必须被淘汰')
    t.eq(cache.get('a'), '1', '被触摸过的 a 必须还在')
    t.eq(cache.get('d'), '4', '新写入的 d 必须还在')
  })

  t.suite('有界缓存：体积上限（大列表不能只按条数算）', () => {
    const cache = new BoundedKvCache({ maxEntries: 100, maxBytes: 100 })
    cache.set('big1', 'x'.repeat(60))
    cache.set('big2', 'x'.repeat(60))
    t.ok(cache.byteSize <= 100, `体积必须受控，实际 ${cache.byteSize}`)
    t.eq(cache.get('big1'), undefined, '先写入的大块应被淘汰')
    t.eq(cache.get('big2')?.length, 60, '后写入的大块应保留')
  })

  t.suite('有界缓存：覆盖写、删除、清空都要正确记账', () => {
    const cache = new BoundedKvCache({ maxEntries: 10, maxBytes: 10_000 })
    cache.set('k', 'aaaa')
    cache.set('k', 'bb')
    t.eq(cache.byteSize, 2, '覆盖写必须替换掉旧体积')
    cache.delete('k')
    t.eq(cache.byteSize, 0, '删除后体积归零')
    t.eq(cache.size, 0, '删除后条数归零')
    cache.set('k2', 'cc')
    cache.clear()
    t.eq(cache.size, 0, '清空后条数为 0')
    t.eq(cache.byteSize, 0, '清空后体积为 0')
  })

  t.suite('有界缓存：淘汰不影响读取正确性（写 200 条后仍能读回第一条）', async() => {
    __resetAsyncStorage()
    __resetNativeKv()
    const keys = []
    for (let i = 0; i < 200; i++) {
      const key = `bulk_${i}`
      keys.push(key)
      await saveData(key, { i, payload: 'x'.repeat(200) })
    }
    // 缓存上限是 128 条，前 72 条已被淘汰；读它们必须回落到 C++/AsyncStorage 拿到正确值
    const first = await getData(keys[0])
    const middle = await getData(keys[100])
    const last = await getData(keys[199])
    t.eq(first, { i: 0, payload: 'x'.repeat(200) }, '被淘汰的第一条必须仍能读对')
    t.eq(middle, { i: 100, payload: 'x'.repeat(200) }, '中间那条必须读对')
    t.eq(last, { i: 199, payload: 'x'.repeat(200) }, '最后写入的那条必须读对')
  })
}
