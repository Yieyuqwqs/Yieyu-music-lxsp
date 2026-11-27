/**
 * 端点形态探测：把「先试 LXSP、失败再逐族探测」的串行等待改成并行，
 * 并且**第一个可用的结果就返回**。
 *
 * 历史（这个文件以前的行为）：
 *   1. 四族探测是串行的 → 最坏 4 × 超时；
 *   2. 即使 LXSP 在 30ms 就回了，也要 `Promise.allSettled` 等旧接口族全部超时（最坏 10s）。
 *   实测（manifest 30ms 返回、旧接口族挂死）：旧实现 1223ms，本实现 ≈ 30ms。
 *
 * 现在的规则：
 *   · LXSP 与旧接口族同时开跑；
 *   · LXSP 一到就用它（它是唯一声明了能力的协议）；
 *   · 旧接口族先到，就先等一个 grace 窗口（默认 150ms）看 LXSP 是否也能到，
 *     等不到才用旧接口族 —— 既不无谓等待，也不因为快而用错协议族。
 */
import { LxspTransport } from './transport'
import { parseManifest } from './manifest'
import { probeApiProfiles, type ApiProfileProbe } from './api-profiles'

import { toLxspError } from './errors'
import type { FetchLike } from './transport'

export type Detection =
  | { kind: 'lxsp', manifest: LX.Lxsp.Manifest, transport: LxspTransport }
  | { kind: 'profile', probe: ApiProfileProbe }

export interface DetectOptions {
  baseUrl: string
  token?: string | null
  fetchImpl: FetchLike
  /** manifest 探测超时，默认 3500ms */
  manifestTimeoutMs?: number
  /** 旧接口族探测超时，默认 2500ms */
  profileTimeoutMs?: number
  /** 旧接口族先到时，等 LXSP 的窗口；默认 150ms */
  manifestGraceMs?: number
}

export interface DetectResult {
  detection: Detection | null
  elapsedMs: number
  error?: string
}

// 探测期只保留一个胜者：LXSP 优先，其次 lx-source → api-wwwweb → api-json。
// 优先级表本身放在 protocol.ts（两边都 import 它，避免 detect ↔ api-profiles 循环依赖）。

type Settled =
  | { which: 'lxsp', detection: Detection }
  | { which: 'lxspFailed', error: unknown }
  | { which: 'profile', detection: Detection | null }

/** 只在 grace 窗口内等一下，窗口一过就返回 null（不留悬挂定时器） */
const waitWithTimeout = async(promise: Promise<Settled>, ms: number): Promise<Settled | null> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, ms)) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const detectEndpoint = async(options: DetectOptions): Promise<DetectResult> => {
  const startedAt = Date.now()
  const manifestTimeoutMs = options.manifestTimeoutMs ?? 3500
  const profileTimeoutMs = options.profileTimeoutMs ?? 2500
  const graceMs = options.manifestGraceMs ?? 150
  const token = options.token ?? null

  const manifestTask = (async(): Promise<Detection> => {
    const transport = new LxspTransport({ baseUrl: options.baseUrl, token, timeoutMs: manifestTimeoutMs, fetchImpl: options.fetchImpl })
    const raw = await transport.getJson<unknown>('/manifest', {}, { timeoutMs: manifestTimeoutMs })
    const manifest = parseManifest(raw)
    return { kind: 'lxsp', manifest, transport }
  })()

  const profileTask = probeApiProfiles({ baseUrl: options.baseUrl, token, fetchImpl: options.fetchImpl, timeoutMs: profileTimeoutMs })
    .then((probe): Detection | null => (probe ? { kind: 'profile', probe } : null))

  // 两个任务都立刻挂上「永不 reject」的包装：早退时不会留下 unhandled rejection
  const lxspSettled: Promise<Settled> = manifestTask.then(
    detection => ({ which: 'lxsp', detection } as Settled),
    error => ({ which: 'lxspFailed', error } as Settled),
  )
  const profileSettled: Promise<Settled> = profileTask.then(
    detection => ({ which: 'profile', detection } as Settled),
    () => ({ which: 'profile', detection: null } as Settled),
  )

  const finish = (detection: Detection | null, error?: string): DetectResult => ({
    detection,
    elapsedMs: Date.now() - startedAt,
    error,
  })

  const first = await Promise.race([lxspSettled, profileSettled])

  // 1) LXSP 赢了：直接返回，不等旧接口族
  if (first.which === 'lxsp') return finish(first.detection)

  // 2) LXSP 明确失败：等旧接口族给出结论（它自己会超时收敛）
  if (first.which === 'lxspFailed') {
    const settledProfile = await profileSettled
    const detection = settledProfile.which === 'profile' ? settledProfile.detection : null
    if (detection) return finish(detection)
    const reason = toLxspError(first.error, 'network')
    return finish(null, `${reason.code}: ${reason.message}`)
  }

  // 3) 旧接口族先回来了
  if (!first.detection) {
    // 旧接口族全部失败：只剩 LXSP 还有机会，等它自己收敛
    const settledLxsp = await lxspSettled
    if (settledLxsp.which === 'lxsp') return finish(settledLxsp.detection)
    const reason = toLxspError(settledLxsp.which === 'lxspFailed' ? settledLxsp.error : null, 'network')
    return finish(null, `${reason.code}: ${reason.message}`)
  }

  // 旧接口族可用，但给 LXSP 一个短暂窗口：同时在线时优先用声明了能力的那个
  const maybeLxsp = await waitWithTimeout(lxspSettled, graceMs)
  if (maybeLxsp?.which === 'lxsp') return finish(maybeLxsp.detection)
  return finish(first.detection)
}

// 兼容旧的导入点：优先级表与限制常量都在 protocol（避免 detect ↔ api-profiles 循环依赖）
export { PROFILE_PRIORITY, DEFAULT_LIMITS } from './protocol'
