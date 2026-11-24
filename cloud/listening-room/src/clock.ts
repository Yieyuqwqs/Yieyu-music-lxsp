/**
 * 锚点状态机 + 时钟同步（纯函数，方便单测）
 *
 * 规则（需求原文）：
 * - PLAY / SEEK / SET_TRACK：anchorServerMs = serverNow + 400
 * - PAUSE：anchorServerMs = serverNow
 * - positionMs 由状态机计算（暂停时表示「停在哪儿」，播放时表示「锚点那一刻在哪儿」）
 * - 客户端播放头 = positionMs + max(0, (deviceNow + clockOffset) - anchorServerMs)，仅 isPlaying
 */
import type { PlaybackState } from './protocol'

/** 控制指令生效的提前量（给网络与渲染留缓冲） */
export const LEAD_MS = 400

export const playheadAt = (playback: PlaybackState, serverNow: number): number => {
  if (!playback.isPlaying) return Math.max(0, playback.positionMs)
  const elapsed = Math.max(0, serverNow - playback.anchorServerMs)
  return Math.max(0, playback.positionMs + elapsed)
}

/** 播放/恢复：从现在的位置起播，锚点前置 400ms */
export const anchorForPlay = (playback: PlaybackState, serverNow: number): PlaybackState => ({
  ...playback,
  anchorServerMs: serverNow + LEAD_MS,
  isPlaying: true,
})

/** 暂停：位置定格在「现在」，锚点就是现在 */
export const anchorForPause = (playback: PlaybackState, serverNow: number): PlaybackState => ({
  ...playback,
  positionMs: playheadAt(playback, serverNow),
  anchorServerMs: serverNow,
  isPlaying: false,
})

/** 拖动：位置换成目标值；在播就前置 400ms，暂停就以现在为锚 */
export const anchorForSeek = (playback: PlaybackState, serverNow: number, positionMs: number): PlaybackState => ({
  ...playback,
  positionMs: Math.max(0, Math.floor(positionMs)),
  anchorServerMs: playback.isPlaying ? serverNow + LEAD_MS : serverNow,
})

/** 换曲：位置归零，锚点前置 400ms（不论此前是否在播，换曲即开播） */
export const anchorForSetTrack = (playback: PlaybackState, serverNow: number, stableKey: string): PlaybackState => ({
  positionMs: 0,
  anchorServerMs: serverNow + LEAD_MS,
  isPlaying: true,
  trackStableKey: stableKey,
})

/**
 * 时钟同步：保留 RTT 最小的那次采样。
 * 客户端每次 np_ping 都带上本地时刻，收到 np_pong 时算：
 *   rtt = (deviceNow - clientNow) - (serverNow2 - serverNow1)   // 若服务端回显 clientNow 即可简化为 deviceNow - clientNow
 *   offset ≈ serverNow - (clientNow + rtt / 2)
 */
export interface ClockSample {
  clientNow: number
  serverNow: number
  rttMs: number
}

export interface ClockSync {
  /** 最佳偏移（加到 deviceNow 上得到服务端时间估计） */
  offsetMs: number
  /** 最佳采样对应的 RTT，越小越可信 */
  bestRttMs: number
  samples: number
}

export const emptyClockSync = (): ClockSync => ({ offsetMs: 0, bestRttMs: Number.POSITIVE_INFINITY, samples: 0 })

export const computeSample = (clientNow: number, deviceNow: number, serverNow: number): ClockSample => {
  const rttMs = Math.max(0, deviceNow - clientNow)
  const offsetMs = serverNow - (clientNow + rttMs / 2)
  return { clientNow, serverNow, rttMs, offsetMs }
}

/** 只在 RTT 更小（或首次）时替换，避免抖动把好样本挤掉 */
export const mergeSample = (sync: ClockSync, sample: ClockSample): ClockSync => {
  const samples = sync.samples + 1
  if (sample.rttMs >= sync.bestRttMs) return { ...sync, samples }
  return { offsetMs: sample.offsetMs, bestRttMs: sample.rttMs, samples }
}

/** 客户端本地播放头（serverNow 由 deviceNow + offset 推出来） */
export const localPlayhead = (playback: PlaybackState, deviceNow: number, sync: ClockSync): number => (
  playheadAt(playback, deviceNow + sync.offsetMs)
)
