/**
 * 一起听会话（App 侧胶水）
 *
 * 只做三件事，别的都不碰：
 * 1. 把「我就是控制端」时的本地 play/pause/seek 上报给房间
 * 2. 把「房间广播的状态」落到本地播放器（偏差超过阈值才 seek，避免抖动）
 * 3. 换曲只做提示，不自动切歌 —— 直链要各自向后端要，切歌涉及队列语义，交给 UI 决定
 *
 * 播放器通过 PlayerAdapter 注入，方便单测（也避免这个文件直接依赖 RN）。
 */
import type { PlaybackMode, RoomState, TrackRef } from './protocol'

/** RoomSession 需要的最小能力（HTTP 客户端与 P2P 房间都满足） */
export interface RoomSessionClient {
  on: (handler: (event: { type: string, [key: string]: unknown }) => void) => () => void
  isController: boolean
  playheadMs: () => number
  play: () => void
  pause: () => void
  seek: (positionMs: number) => void
  setTrack: (track: TrackRef, index?: number) => void
  setMode: (mode: PlaybackMode) => void
  notifyTrackFinished: () => void
  requestPlay: () => void
  requestPause: () => void
  requestSeek: (positionMs: number) => void
}

export interface PlayerAdapter {
  play: () => void
  pause: () => void
  /** 毫秒 */
  seek: (positionMs: number) => void
  isPlaying: () => boolean
  /** 毫秒 */
  positionMs: () => number
  /** 可选：微调播放速率（1.0 = 正常），用于小偏差追赶 */
  setRate?: (rate: number) => void
  currentTrack: () => TrackRef | null
}

export interface RoomSessionOptions {
  client: RoomSessionClient
  player: PlayerAdapter
  /** 播放头偏差超过这个值才强制对齐，默认 400ms */
  driftThresholdMs?: number
  /** 成员侧强制对齐间隔（毫秒），默认 1.5 秒；房主不用这个 */
  onEvent?: (event: RoomSessionEvent) => void
}

export type RoomSessionEvent =
  | { type: 'applied', action: 'play' | 'pause' | 'seek', positionMs?: number }
  | { type: 'track_changed', track: TrackRef, remote: boolean }
  | { type: 'error', message: string }

export class RoomSession {
  private readonly client: RoomSessionClient
  private readonly player: PlayerAdapter
  private readonly driftThresholdMs: number
  private readonly onEvent?: (event: RoomSessionEvent) => void
  private applyingRemote = false
  private lastRemoteTrackKey: string | null = null
  private unsubscribe: (() => void) | null = null
  private started = false
  /** 成员侧：最后一次房间状态，用来做强制对齐 */
  private lastState: RoomState | null = null

  constructor(options: RoomSessionOptions) {
    this.client = options.client
    this.player = options.player
    this.driftThresholdMs = options.driftThresholdMs ?? 1000
    this.onEvent = options.onEvent
  }

  /** 开始监听房间广播并把状态落到本地 */
  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.client.on((event) => {
      if (event.type === 'state') this.applyState(event.state as RoomState)
      else if (event.type === 'error') this.emit({ type: 'error', message: String(event.message ?? '') })
    })
  }

  stop(): void {
    this.started = false
    this.lastState = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** 房间状态 → 本地播放器 */
  applyState(state: RoomState): RoomSessionEvent[] {
    this.lastState = state
    const events: RoomSessionEvent[] = []
    if (this.client.isController) return events // 控制端以本地为准，不被自己的广播反向扯动

    const remoteTrackKey = state.playback.trackStableKey
    if (remoteTrackKey !== this.lastRemoteTrackKey) {
      this.lastRemoteTrackKey = remoteTrackKey
      const track = state.queue[state.currentIndex] ?? null
      if (track) {
        const event: RoomSessionEvent = { type: 'track_changed', track, remote: true }
        events.push(event)
        this.emit(event)
      }
    }

    const shouldPlay = state.playback.isPlaying
    if (shouldPlay !== this.player.isPlaying()) {
      this.applyingRemote = true
      if (shouldPlay) this.player.play()
      else this.player.pause()
      this.applyingRemote = false
      const event: RoomSessionEvent = { type: 'applied', action: shouldPlay ? 'play' : 'pause' }
      events.push(event)
      this.emit(event)
    }

    // 漂移修正（行业通行做法）：
    //   < 50ms 不动 ｜ 50-300ms 改播放速率慢慢追 ｜ > 300ms 直接 seek
    const target = this.client.playheadMs()
    const current = this.player.positionMs()
    if (target > 0) {
      const drift = target - current
      const abs = Math.abs(drift)
      if (abs > this.driftThresholdMs) {
        this.applyingRemote = true
        this.player.seek(target)
        this.applyingRemote = false
        this.emitAndPush(events, { type: 'applied', action: 'seek', positionMs: target })
      } else if (abs > 100 && this.player.setRate && state.playback.isPlaying) {
        this.applyingRemote = true
        // 落后就略快、超前就略慢，追上后恢复 1.0
        this.player.setRate(drift > 0 ? 1.06 : 0.94)
        this.applyingRemote = false
        setTimeout(() => { this.player.setRate?.(1) }, 1200)
      }
    }
    return events
  }

  // ------------------------------------------------ 控制端：本地 → 房间

  notifyPlay(): void {
    if (!this.isSendingAllowed()) return
    this.client.play()
  }

  notifyPause(): void {
    if (!this.isSendingAllowed()) return
    this.client.pause()
  }

  notifySeek(positionMs?: number): void {
    if (!this.isSendingAllowed()) return
    this.client.seek(positionMs ?? this.player.positionMs())
  }

  notifyTrackChanged(track?: TrackRef, index?: number): void {
    if (!this.isSendingAllowed()) return
    const target = track ?? this.player.currentTrack()
    if (!target) return
    this.client.setTrack(target, index)
    this.emit({ type: 'track_changed', track: target, remote: false })
  }

  notifyMode(mode: PlaybackMode): void {
    if (!this.isSendingAllowed()) return
    this.client.setMode(mode)
  }

  notifyFinished(): void {
    if (!this.isSendingAllowed()) return
    this.client.notifyTrackFinished()
  }

  /** 成员端：走 REQUEST_* */
  requestPlay(): void { this.client.requestPlay() }
  requestPause(): void { this.client.requestPause() }
  requestSeek(positionMs?: number): void { this.client.requestSeek(positionMs ?? this.player.positionMs()) }

  /** 控制端才能改房间；成员端改走 request* */
  private isSendingAllowed(): boolean {
    if (this.applyingRemote) return false
    return this.client.isController
  }

  private emitAndPush(list: RoomSessionEvent[], event: RoomSessionEvent): void {
    list.push(event)
    this.emit(event)
  }

  private emit(event: RoomSessionEvent): void {
    this.onEvent?.(event)
  }
}
