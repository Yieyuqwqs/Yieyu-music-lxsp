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

/** 控制指令生效的提前量（与云版一致） */
export const LEAD_MS = 400

/** 播放/恢复：锚点前置 400ms */
export const anchorForPlay = (playback: PlaybackState, serverNow: number, leadMs: number = LEAD_MS): PlaybackState => ({
  ...playback,
  anchorServerMs: serverNow + leadMs,
  isPlaying: true,
})

/** 暂停：位置定格在现在 */
export const anchorForPause = (playback: PlaybackState, serverNow: number): PlaybackState => ({
  ...playback,
  positionMs: playheadAt(playback, serverNow),
  anchorServerMs: serverNow,
  isPlaying: false,
})

/** 拖动 */
export const anchorForSeek = (playback: PlaybackState, serverNow: number, positionMs: number, leadMs: number = LEAD_MS): PlaybackState => ({
  ...playback,
  positionMs: Math.max(0, Math.floor(positionMs)),
  anchorServerMs: playback.isPlaying ? serverNow + leadMs : serverNow,
})

/** 换曲：位置归零并开播 */
export const anchorForSetTrack = (playback: PlaybackState, serverNow: number, stableKey: string, leadMs: number = LEAD_MS): PlaybackState => ({
  positionMs: 0,
  anchorServerMs: serverNow + leadMs,
  isPlaying: true,
  trackStableKey: stableKey,
})


/**
 * 严谨版播放头：完全用单调时钟增量，不用跨设备的 epoch 差
 *
 * 快照 = 某次收到 room_state_updated 时的三元组：
 *   positionMs / anchorServerMs / serverNow（都来自同一条消息，天然同源）
 * 之后就靠单调时钟算「过了多久」：
 *   elapsed = (anchorServerMs <= serverNow ? serverNow - anchorServerMs : 0) + (monoNow - monoAtReceive)
 * 播放头 = positionMs + max(0, elapsed)   （仅 isPlaying）
 *
 * 好处：不依赖两台手机的系统时间是否一致，也不会被校时/改时间影响。
 */
export interface PlaybackSnapshot {
  positionMs: number
  anchorServerMs: number
  isPlaying: boolean
  serverNow: number
  monoAtReceive: number
}

export const snapshotOf = (playback: PlaybackState, serverNow: number, monoAtReceive: number): PlaybackSnapshot => ({
  positionMs: Math.max(0, playback.positionMs),
  anchorServerMs: playback.anchorServerMs,
  isPlaying: playback.isPlaying,
  serverNow,
  monoAtReceive,
})

/** 距离「锚点真正生效」还有多少毫秒（>=0：还要等；<0：已经开播了） */
export const leadRemainingMs = (snapshot: PlaybackSnapshot, monoNow: number): number => {
  const anchorAtReceive = snapshot.anchorServerMs - snapshot.serverNow // 锚点相对接收时刻的偏移
  const anchorMono = snapshot.monoAtReceive + anchorAtReceive
  return anchorMono - monoNow
}

export const playheadFromSnapshot = (snapshot: PlaybackSnapshot, monoNow: number): number => {
  if (!snapshot.isPlaying) return snapshot.positionMs
  const elapsed = (monoNow - snapshot.monoAtReceive) - (snapshot.anchorServerMs - snapshot.serverNow)
  return Math.max(0, snapshot.positionMs + Math.max(0, elapsed))
}
