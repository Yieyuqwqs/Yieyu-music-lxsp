/**
 * 状态下沉（M2）：把「域」的真源交给 C++，TS 侧只保留镜像。
 *
 * 数据流：
 *   组件 → action → patchState(域, 增量)  ──post──▶ C++ StateBox（真源）
 *                                              │
 *                                      emit 'core.state' {d, s}
 *                                              ▼
 *   订阅回调 → 域的 apply(snapshot) → 覆盖本地镜像 → 触发原有 state_event（UI 无感）
 *
 * 为什么先「镜像」而不是直接删掉 TS 状态：
 *   17 个域一次切完风险太大；镜像期两个来源同时更新，任何一边坏掉界面都还能用，
 *   等所有域都验证过再删镜像（M2 收尾）。
 */
import { isCoreSupported, post, request, subscribe } from './index'

type Snapshot = Record<string, unknown>
type Applier = (snapshot: Snapshot) => void

const registry = new Map<string, Applier>()
let started = false

/** 注册某个域的「事件回灌」处理（在 store 模块里调用一次） */
export const registerDomain = (domain: string, apply: Applier) => {
  registry.set(domain, apply)
}

/** 把增量写进 C++ 真源（单向，不等待） */
export const patchState = (domain: string, patch: Record<string, unknown>) => {
  post('state.patch', { d: domain, p: patch })
}

/**
 * 写状态：核心可用时**只写 C++**（单源），本地缓存等事件回来再更新；
 * 核心不可用（32 位/加载失败）时退回本地写入，保证界面永远能动。
 * 这条规矩只适用于「非输入类」状态（网络结果、服务端状态、播放信息）；
 * 输入类（搜索词、滑块）必须保留本地即时写入，否则打字会卡。
 */
export const pushState = (domain: string, patch: Record<string, unknown>, applyLocal?: () => void) => {
  if (isCoreSupported) {
    patchState(domain, patch)
    return
  }
  try {
    applyLocal?.()
  } catch { /* noop */ }
}

/** 启动事件回灌：一个订阅处理所有域 */
export const initStateSync = () => {
  if (started) return
  started = true
  // M3：启动水合 —— C++ 里落库的状态在冷启动时就灌回本地缓存，
  // 这样「真源」永远是 C++（进程死了也能恢复），TS 仅仅是一层可丢弃的展示缓存。
  void request<Record<string, Record<string, unknown>>>('state.all').then(all => {
    if (!all || typeof all != 'object') return
    for (const [domain, snapshot] of Object.entries(all)) {
      const apply = registry.get(domain)
      if (!apply || !snapshot) continue
      try {
        apply(snapshot)
      } catch { /* 单个域失败不影响其它域 */ }
    }
  }).catch(() => { /* 核心不可用时静默降级为纯本地缓存 */ })
  subscribe('core.state.bulk', (payload: any) => {
    if (!payload || typeof payload != 'object') return
    for (const [domain, snapshot] of Object.entries(payload as Record<string, Record<string, unknown>>)) {
      const apply = registry.get(domain)
      if (!apply || !snapshot) continue
      try { apply(snapshot) } catch { /* 单域失败不影响其它域 */ }
    }
  })
  subscribe('core.state', (payload: any) => {
    if (!payload || typeof payload != 'object') return
    const apply = registry.get(payload.d)
    if (!apply) return
    if (!payload.s || typeof payload.s != 'object') return
    try {
      apply(payload.s)
    } catch { /* 单个域回灌失败不能影响别的域 */ }
  })
}
