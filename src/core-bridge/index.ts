/**
 * Yieyu Core 的 JS 桥（M0 地基）
 *
 * 唯一职责：把「业务事件」翻译成 React 能用的订阅，把「用户动作」翻译成 post/request。
 * 这里**不放业务逻辑**，也不持有任何业务状态——状态的真源在 C++。
 *
 * 设计约束（见 ARCH_FAT_CORE.md §4）：
 *  - 所有 native 调用必须非阻塞：post 是单向投递，request 有 3s 硬超时（Java 侧兜底）。
 *  - 订阅必须能精确回收（组件卸载即 unsubscribe），否则就是内存红线里第 5 条。
 *  - 事件 payload 是 JSON 字符串，解析失败绝不能让界面崩。
 */
import { AppState, DeviceEventEmitter, NativeModules, Platform } from 'react-native'

const PREFIX = 'YieyuCore:'

interface CoreNative {
  post: (op: string, payload: string, seq: number) => void
  request: (op: string, payload: string) => Promise<string>
  subscribe: (topic: string, maxHz: number) => void
  unsubscribe: (topic: string) => void
  setForeground: (foreground: boolean) => void
  stopCore: () => void
  getStats: () => Promise<string>
}

const native = NativeModules.YieyuCore as CoreNative | undefined

export const isCoreSupported = Platform.OS === 'android' && !!native

export interface CoreStats {
  version: string
  generation: number
  uptimeMs: number
  commandsIn: number
  commandsHandled: number
  commandsDropped: number
  eventsIn: number
  eventsOut: number
  eventsDropped: number
  eventsThrottled: number
  deliverErrors: number
  queueCmds: number
  queueEvents: number
  cmdCap: number
  evCap: number
  globalRefs: number
  subscriptions: number
  lastEnqueueUs: number
  lastDeliverUs: number
  // M1b：C++ 侧 SQLite（大歌单/设置双写的正主）
  dbOpened?: boolean
  dbEntries?: number
  dbBytes?: number
  dbWrites?: number
  dbReads?: number
  dbRemoves?: number
  dbErrors?: number
  dbImported?: number
  dbLastWriteUs?: number
  // M2：C++ 状态真源规模（域数 / 字段数）
  stateDomains?: number
  stateFields?: number
}

type Handler = (data: any) => void

const handlers = new Map<string, Set<Handler>>()
// 订阅引用计数：只有 0→1 才真正 addListener，1→0 立刻 remove（防第 5 条内存泄漏）
const subs = new Map<string, { subscription: { remove: () => void }, refs: number }>()

let seq = 0

const parse = (raw: string): any => {
  try {
    return JSON.parse(raw)
  } catch {
    return { _raw: raw }
  }
}

export const subscribe = (topic: string, handler: Handler, maxHz = 0): (() => void) => {
  const set = handlers.get(topic) ?? new Set<Handler>()
  handlers.set(topic, set)
  set.add(handler)

  let entry = subs.get(topic)
  if (!entry) {
    if (!native) return () => { /* noop：不支持时返回空回收函数，调用方无需判空 */ }
    const subscription = DeviceEventEmitter.addListener(PREFIX + topic, (raw: unknown) => {
      const data = typeof raw == 'string' ? parse(raw) : raw
      const current = handlers.get(topic)
      if (!current) return
      current.forEach(cb => {
        try {
          cb(data)
        } catch { /* UI 回调自己炸了不能影响别的订阅者 */ }
      })
    })
    native.subscribe(topic, maxHz)
    entry = { subscription, refs: 0 }
    subs.set(topic, entry)
  }
  entry.refs++

  let released = false
  return () => {
    if (released) return
    released = true
    const current = handlers.get(topic)
    current?.delete(handler)
    const target = subs.get(topic)
    if (!target) return
    target.refs--
    if (target.refs <= 0) {
      target.subscription.remove()
      subs.delete(topic)
      try {
        native?.unsubscribe(topic)
      } catch { /* 卸载阶段 native 可能已不可用 */ }
    }
  }
}

/** 单向命令：绝不返回 Promise，绝不让 UI 等 */
export const post = (op: string, payload: Record<string, unknown> = {}) => {
  if (!native) return
  try {
    native.post(op, JSON.stringify(payload), ++seq)
  } catch { /* native 不可用时静默降级，不影响播放 */ }
}

/** 一次性请求：Java 侧 3s 超时，这里再兜一层，绝不悬挂 */
export const request = async <T = any>(op: string, payload: Record<string, unknown> = {}): Promise<T | null> => {
  if (!native) return null
  try {
    const raw = await native.request(op, JSON.stringify(payload))
    return parse(raw) as T
  } catch {
    return null
  }
}

export const getCoreStats = async(): Promise<CoreStats | null> => {
  if (!native) return null
  try {
    return parse(await native.getStats()) as CoreStats
  } catch {
    return null
  }
}

/** 卸载 / reload 前调用，保证 GlobalRef 与后台线程干净退出 */
export const stopCore = () => {
  try {
    native?.stopCore()
  } catch { /* noop */ }
}

let listening = false
/** 前后台切换：后台降频（省电 + 防被系统杀），只投递一次状态，不做任何计算 */
const startForegroundTracking = () => {
  if (listening || !native) return
  listening = true
  native.setForeground(AppState.currentState == 'active')
  AppState.addEventListener('change', state => {
    try {
      native.setForeground(state == 'active')
    } catch { /* noop */ }
  })
}

export interface ProbeResult {
  ok: boolean
  stats?: CoreStats
  elapsedMs: number
  error?: string
}

/** M0 自检：一次 request 往返 + 一次事件订阅，验证通路与延迟 */
export const probeCore = async(): Promise<ProbeResult> => {
  const started = Date.now()
  if (!isCoreSupported) {
    return { ok: false, elapsedMs: 0, error: '不是 Android 或原生模块未注册' }
  }
  const raw = await request<CoreStats>('core.selftest')
  const elapsedMs = Date.now() - started
  if (!raw) return { ok: false, elapsedMs, error: '3s 内没有收到应答（超时）' }
  return { ok: true, stats: raw, elapsedMs }
}

let inited = false
export const initCoreBridge = () => {
  if (inited || !native) return
  inited = true
  startForegroundTracking()
  // 预热：一次 ping，不等待结果，失败也无所谓
  post('core.ping', { from: 'init' })
}
