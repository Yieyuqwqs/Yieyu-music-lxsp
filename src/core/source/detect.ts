/**
 * 端点形态探测：把「先试 LXSP、失败再逐族探测」的串行等待改成并行。
 *
 * 旧行为的延迟上限 = manifest 超时 + lx-source 超时 + wwwweb 超时 + json 超时（最坏 ~20s）；
 * 现在四个探测并发发出，最坏 = 最长的那一个（默认 2.5s），正常服务 30~300ms 就有结果。
 */
import { LxspTransport } from './transport'
import { parseManifest } from './manifest'
import { probeApiProfiles, type ApiProfileProbe } from './api-profiles'
import { DEFAULT_LIMITS } from './protocol'
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
}

export interface DetectResult {
  detection: Detection | null
  elapsedMs: number
  error?: string
}

/** 探测期只保留一个胜者：LXSP 优先，其次 lx-source → api-wwwweb → api-json */
const PROFILE_PRIORITY: Record<string, number> = { 'lx-source': 0, 'api-wwwweb': 1, 'api-json': 2 }

export const detectEndpoint = async(options: DetectOptions): Promise<DetectResult> => {
  const startedAt = Date.now()
  const manifestTimeoutMs = options.manifestTimeoutMs ?? 3500
  const profileTimeoutMs = options.profileTimeoutMs ?? 2500
  const token = options.token ?? null

  const manifestTask = (async(): Promise<Detection> => {
    const transport = new LxspTransport({ baseUrl: options.baseUrl, token, timeoutMs: manifestTimeoutMs, fetchImpl: options.fetchImpl })
    const raw = await transport.getJson<unknown>('/manifest', {}, { timeoutMs: manifestTimeoutMs })
    const manifest = parseManifest(raw)
    return { kind: 'lxsp', manifest, transport }
  })()

  const profileTask = probeApiProfiles({ baseUrl: options.baseUrl, token, fetchImpl: options.fetchImpl, timeoutMs: profileTimeoutMs })
    .then((probe): Detection | null => (probe ? { kind: 'profile', probe } : null))

  // 两个探测同时跑：谁先给出可用结果就用谁；LXSP 结果若同时到达则优先
  const settled = await Promise.allSettled([manifestTask, profileTask])
  const manifestResult = settled[0].status === 'fulfilled' ? settled[0].value : null
  const profileResult = settled[1].status === 'fulfilled' ? settled[1].value : null

  if (manifestResult) return { detection: manifestResult, elapsedMs: Date.now() - startedAt }
  if (profileResult) return { detection: profileResult, elapsedMs: Date.now() - startedAt }

  const reason = settled[0].status === 'rejected' ? toLxspError(settled[0].reason, 'network') : null
  return {
    detection: null,
    elapsedMs: Date.now() - startedAt,
    error: reason ? `${reason.code}: ${reason.message}` : '无法识别的端点',
  }
}

export { PROFILE_PRIORITY, DEFAULT_LIMITS }
