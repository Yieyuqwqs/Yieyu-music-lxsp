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
import type { ListenTogetherClient } from './client'
import type { PlaybackMode, RoomState, TrackRef } from './protocol'

export interface PlayerAdapter {
  play: () => void
  pause: () => void
  /** 毫秒 */
  seek: (positionMs: number) => void
  isPlaying: () => boolean
  /** 毫秒 */
  positionMs: () => number
  currentTrack: () => TrackRef | null
}

export interface RoomSessionOptions {
  client: ListenTogetherClient
  player: PlayerAdapter
  /** 播放头偏差超过这个值才强制对齐，默认 400ms */
  driftThresholdMs?: number
  onEvent?: (event: RoomSessionEvent) => void
}

export type RoomSessionEvent =
  | { type: 'applied', action: 'play' | 'pause' | 'seek', positionMs?: number }
  | { type: 'track_changed', track: TrackRef, remote: boolean }
  | { type: 'error', message: string }

export class RoomSession {
  private readonly client: ListenTogetherClient
  private readonly player: PlayerAdapter
  private readonly driftThresholdMs: number
  private readonly onEvent?: (event: RoomSessionEvent) => void
  private applyingRemote = false
  private lastRemoteTrackKey: string | null = null
  private unsubscribe: (() => void) | null = null
  private started = false

  constructor(options: RoomSessionOptions) {
    this.client = options.client
    this.player = options.player
    this.driftThresholdMs = options.driftThresholdMs ?? 400
    this.onEvent = options.onEvent
  }

  /** 开始监听房间广播并把状态落到本地 */
  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.client.on((event) => {
      if (event.type === 'state') this.applyState(event.state)
      else if (event.type === 'error') this.emit({ type: 'error', message: event.message })
    })
  }

  stop(): void {
    this.started = false
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** 房间状态 → 本地播放器 */
  applyState(state: RoomState): RoomSessionEvent[] {
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

    // 播放头对齐：只在不播放/或偏差过大时 seek，避免每次广播都抖一下
    const target = this.client.playheadMs()
    const current = this.player.positionMs()
    if (target > 0 && Math.abs(target - current) > this.driftThresholdMs) {
      this.applyingRemote = true
      this.player.seek(target)
      this.applyingRemote = false
      const event: RoomSessionEvent = { type: 'applied', action: 'seek', positionMs: target }
      events.push(event)
      this.emit(event)
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

  private emit(event: RoomSessionEvent): void {
    this.onEvent?.(event)
  }
}
