/**
 * 客户端播放头与时钟校准（纯函数，与 cloud/listening-room/src/clock.ts 同规则）
 *
 * playhead = positionMs + max(0, (deviceNow + clockOffset) - anchorServerMs)   // 仅 isPlaying
 */
import type { PlaybackState } from './protocol'

export interface ClockSync {
  offsetMs: number
  bestRttMs: number
  samples: number
}

export const emptyClockSync = (): ClockSync => ({ offsetMs: 0, bestRttMs: Number.POSITIVE_INFINITY, samples: 0 })

export const playheadAt = (playback: PlaybackState, serverNow: number): number => {
  if (!playback.isPlaying) return Math.max(0, playback.positionMs)
  return Math.max(0, playback.positionMs + Math.max(0, serverNow - playback.anchorServerMs))
}

/** 收到 np_pong 时算一次样本：rtt 越小的样本越可信，只保留最好的那个 */
export const mergePong = (sync: ClockSync, clientNow: number, deviceNow: number, serverNow: number): ClockSync => {
  const rttMs = Math.max(0, deviceNow - clientNow)
  const offsetMs = serverNow - (clientNow + rttMs / 2)
  const samples = sync.samples + 1
  if (rttMs >= sync.bestRttMs) return { ...sync, samples }
  return { offsetMs, bestRttMs: rttMs, samples }
}

/** 由本地时间推服务端时间 */
export const serverNowOf = (deviceNow: number, sync: ClockSync): number => deviceNow + sync.offsetMs

/** 当前应该播放到哪儿（毫秒） */
export const localPlayhead = (playback: PlaybackState, deviceNow: number, sync: ClockSync): number => (
  playheadAt(playback, serverNowOf(deviceNow, sync))
)

/** 本地与房间的偏差（正数=本地快了），用于“本地起播前先对齐” */
export const driftMs = (playback: PlaybackState, deviceNow: number, sync: ClockSync): number => (
  localPlayhead(playback, deviceNow, sync) - playheadAt(playback, serverNowOf(deviceNow, sync))
)
