/**
 * 存储层一致性（数据丢失/复活类 bug 的回归测试）
 *
 * 背景：storage 有两条写入路径（单条 saveData / 批量 saveDataMultiple）和三层介质
 * （内存 kvCache、C++ SQLite kv、AsyncStorage）。任何一条路径漏掉其中一层，
 * 读回来的就是旧值 —— 这不是"经验判断"，下面每条断言都直接打出来。
 *
 * 用桩：tests/lxsp/stubs/react-native.mjs（内存版 YieyuCore kv）+ stubs/async-storage.mjs。
 */
import {
  saveData,
  getData,
  removeData,
  saveDataMultiple,
  removeDataMultiple,
} from '../../src/plugins/storage.ts'
import { __resetAsyncStorage } from './stubs/async-storage.mjs'
import { __nativeKv, __resetNativeKv } from './stubs/react-native.mjs'

const runs = (t, name, fn) => t.suite(name, fn)

export default (t) => {
  t.suite('存储一致性：单条写入必须三层都落地', async() => {
    __resetAsyncStorage()
    __resetNativeKv()
    await saveData('k1', { v: 1 })
    t.eq(await getData('k1'), { v: 1 }, '读回来必须是刚写的值')
    t.ok(__nativeKv.has('k1'), 'C++ kv 必须同步写到（SQLite 是刷新后的真源）')
  })

  t.suite('存储一致性：批量写入后读回必须是新值（不是上一次的旧值）', async() => {
    __resetAsyncStorage()
    __resetNativeKv()
    // 先制造一份"旧值"：单条写入会同时进缓存与 C++
    await saveData('list_a', [{ id: 'old' }])
    t.eq(await getData('list_a'), [{ id: 'old' }], '前置：旧值可读')
    // 列表批量保存走的是 saveDataMultiple
    await saveDataMultiple([['list_a', [{ id: 'new' }]], ['list_b', [{ id: 'b' }]]])
    t.eq(await getData('list_a'), [{ id: 'new' }], '批量写入后必须读到新值（漏双写会读到旧值）')
    t.eq(await getData('list_b'), [{ id: 'b' }], '批量写入的新 key 也必须可读')
    t.ok(__nativeKv.has('list_b'), '批量写入同样必须镜像到 C++ kv')
  })

  t.suite('存储一致性：删除后不能再读到（解封/删列表不能复活）', async() => {
    __resetAsyncStorage()
    __resetNativeKv()
    await saveData('license.bannedEntry', 'DEVICE-X')
    t.eq(await getData('license.bannedEntry'), 'DEVICE-X', '前置：封禁键已写入')
    await removeData('license.bannedEntry')
    t.eq(await getData('license.bannedEntry'), null, '删除后必须读到 null（不清缓存会读到旧封禁值）')
    t.ok(!__nativeKv.has('license.bannedEntry'), 'C++ kv 也必须删掉')
  })

  t.suite('存储一致性：批量删除同样不能留缓存', async() => {
    __resetAsyncStorage()
    __resetNativeKv()
    await saveData('l1', [1])
    await saveData('l2', [2])
    await removeDataMultiple(['l1', 'l2'])
    t.eq(await getData('l1'), null, 'l1 删除后必须读到 null')
    t.eq(await getData('l2'), null, 'l2 删除后必须读到 null')
    t.ok(!__nativeKv.has('l1') && !__nativeKv.has('l2'), 'C++ kv 不能留残留')
  })

  t.suite('存储一致性：解封流程（license 真实调用序列）', async() => {
    __resetAsyncStorage()
    __resetNativeKv()
    const KEY = 'license.bannedQq'
    await saveData(KEY, 'QQ-KEY-1')
    // license.ts 的真实判断：getData 命中就 removeData
    if (await getData(KEY) === 'QQ-KEY-1') await removeData(KEY)
    t.eq(await getData(KEY), null, '解封之后再次读到封禁值 = 永久封禁（原 bug）')
  })
}
