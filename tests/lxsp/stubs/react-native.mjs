// node 侧的 react-native 桩（测试专用）
//
// 为什么有它：resolve-ts.mjs 一直把 'react-native' 映射到本文件，但这个文件此前不存在，
// 于是任何 import 了 react-native 的源码（core-bridge / plugins/storage 链路）在 node 下都不可测。
//
// 约定：YieyuCore 原生模块用内存 Map 实现 kv.set/get/remove，行为与 C++ 侧一致，
// 所以 plugins/storage.ts 的「双写 + 缓存」路径可以在没有任何设备的情况下真跑一遍。
const kv = new Map()
const kvLog = []

export const __nativeKv = kv
export const __kvLog = kvLog
export const __resetNativeKv = () => { kv.clear(); kvLog.length = 0 }

const reply = (value) => Promise.resolve(JSON.stringify(value))

const parsePayload = (payload) => {
  try { return JSON.parse(payload ?? '{}') } catch (error) { return {} }
}

const fakeCore = {
  post(op, payload) {
    kvLog.push({ kind: 'post', op, payload })
    const body = parsePayload(payload)
    if (op === 'kv.set' && typeof body.k === 'string') kv.set(body.k, body.v)
    else if (op === 'kv.remove' && typeof body.k === 'string') kv.delete(body.k)
  },
  request(op, payload) {
    kvLog.push({ kind: 'request', op, payload })
    const body = parsePayload(payload)
    if (op === 'kv.get') {
      return kv.has(body.k) ? reply({ found: true, v: kv.get(body.k) }) : reply({ found: false })
    }
    if (op === 'kv.set') { kv.set(body.k, body.v); return reply({ ok: true }) }
    if (op === 'kv.remove') { kv.delete(body.k); return reply({ ok: true }) }
    return reply({ ok: true })
  },
  subscribe() {},
  unsubscribe() {},
  setForeground() {},
  stopCore() {},
  getStats() { return reply({ version: 'stub', generation: 1, uptimeMs: 0 }) },
}

export const NativeModules = { YieyuCore: fakeCore }

export const Platform = {
  OS: 'android',
  Version: 34,
  select: (spec) => (spec && typeof spec === 'object' ? spec.android : spec),
}

export const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove () {} }),
}

export const DeviceEventEmitter = {
  addListener: () => ({ remove () {} }),
  removeListener: () => {},
  emit: () => {},
  removeAllListeners: () => {},
}

export const Dimensions = {
  get: () => ({ width: 400, height: 800, scale: 1, fontScale: 1 }),
  addEventListener: () => ({ remove () {} }),
}

export const PixelRatio = { get: () => 1, getFontScale: () => 1 }
export const StyleSheet = { create: (obj) => obj, flatten: (obj) => obj, absoluteFill: {} }
export const InteractionManager = { runAfterInteractions: (fn) => { fn(); return { cancel () {} } } }

export default {
  NativeModules,
  Platform,
  AppState,
  DeviceEventEmitter,
  Dimensions,
  PixelRatio,
  StyleSheet,
  InteractionManager,
}
