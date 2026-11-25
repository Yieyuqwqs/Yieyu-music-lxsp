/**
 * 播放自动核验的「记录」部分（纯函数，无 RN 依赖，可以单测）
 *
 * 根因（2026-11-25 接管审计）：旧版 autocheck.ts 里写的是
 *   state = String((await getPlaybackState?.())?.state ?? 'unavailable')
 * 于是 `unavailable` 这个**占位串**被当成测量结果写进 /sdcard/lxsp-autocheck.json。
 * 这份文件是排查时唯一能读到的运行时证据，结果它记的东西不能归因：
 *   - 分不清「播放器没准备好」和「这个 API 版本没有 getPlaybackState」
 *   - 没有曲目 id / 主机，247ms 到底属于哪条链接无从判断
 * 所以把「记录怎么构成」抽成纯函数，并钉死三条不变量：
 *   1. 没测到就是 null，绝不写占位串
 *   2. 直链只记主机（host），不落签名参数
 *   3. 记录必须能定位到具体曲目（id / source / host 至少一个非空才可能排查）
 */

export interface ActiveTrackLike {
  id?: unknown
  url?: unknown
  source?: unknown
}

export interface CheckRecord {
  at: string
  seq: number
  durationMs: number
  positionMs: number
  /** 真实测量值；没测到就是 null（旧版会写 'unavailable' 占位，禁止） */
  state: string | null
  ok: boolean
  /** 曲目标识（用于把 247ms 这类异常归因到具体歌曲） */
  trackId: string | null
  trackSource: string | null
  /** 只保留主机名，签名参数/路径一律不落盘 */
  trackUrlHost: string | null
}

/** 核验通过的门槛：duration 必须像一首真歌（> 5 秒） */
export const OK_DURATION_MS = 5000

/** 从直链里取主机名；取不到就 null（绝不抛错，也绝不把整条 URL 写进记录） */
export const hostOf = (url: unknown): string | null => {
  if (typeof url !== 'string' || !url) return null
  try {
    const parsed = new URL(url)
    return parsed.host || null
  } catch {
    // 不是绝对 URL：只接受 host:port/xxxx 这种形态，其余一律视为不可解析
    const match = /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?/i.exec(url)
    return match ? match[0] : null
  }
}

const str = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * 把一次采样构造成记录。所有入参都是「原始测量值」，这里不做任何代填。
 */
export const buildCheckRecord = (input: {
  at: string
  seq: number
  durationMs: number
  positionMs: number
  state: unknown
  activeTrack?: ActiveTrackLike | null
}): CheckRecord => {
  const durationMs = Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : 0
  const positionMs = Number.isFinite(input.positionMs) ? Math.round(input.positionMs) : 0
  const track = input.activeTrack ?? null
  return {
    at: input.at,
    seq: input.seq,
    durationMs,
    positionMs,
    state: str(input.state),
    ok: durationMs > OK_DURATION_MS,
    trackId: track ? str(track.id) : null,
    trackSource: track ? str(track.source) : null,
    trackUrlHost: track ? hostOf(track.url) : null,
  }
}
