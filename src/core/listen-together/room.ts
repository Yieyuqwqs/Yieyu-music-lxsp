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
  /** 已应用过的房间状态版本（显式声明：之前是运行时动态属性，类型上并不存在） */
  private lastAppliedVersion: number | null = null
  /** 远端换歌后待执行的「起播对齐」位置；消费一次即清空（不变量：每次换歌最多 seek 一次） */
  private pendingAlignMs: number | null = null

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
    this.lastAppliedVersion = null
    this.lastRemoteTrackKey = null
    this.pendingAlignMs = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** 房间状态 → 本地播放器 */
  applyState(state: RoomState): RoomSessionEvent[] {
    this.lastState = state
    const events: RoomSessionEvent[] = []
    // 控制端以本地为准
    if (this.client.isController) return events

    // 结构：只在「房间状态版本真的变了」时应用一次。
    // 广播每 3 秒重复一次同版本状态，若每次都执行 track/play/pause/seek，
    // 就会和本地播放器互相拉扯——这正是「每秒被拽回」的根因。
    if (this.lastAppliedVersion != null && state.version === this.lastAppliedVersion) return events
    this.lastAppliedVersion = state.version

    const remoteTrackKey = state.playback.trackStableKey
    if (remoteTrackKey !== this.lastRemoteTrackKey) {
      this.lastRemoteTrackKey = remoteTrackKey
      const track = state.queue[state.currentIndex] ?? null
      if (track) {
        // 起播对齐的唯一入口：远端换歌后记下「房间此刻播到哪」，
        // 等本机切歌成功（switchToTrack 完成）再消费这一条位置，恰好 seek 一次。
        // 不在 applyState 里直接 seek：此刻本机活动轨还是上一首，seek 会落在错的曲目上。
        this.pendingAlignMs = Math.max(0, this.client.playheadMs())
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

    // 位置对齐只发生在「换歌起播」那一刻（见 alignAfterSwitch），
    // 这里不做任何周期性 seek 或调速——避免把用户从房间位置反复拽走。
    return events
  }

  /**
   * 远端换歌、本机切歌成功之后调用：把成员落到房间播放头（一次性）。
   *
   * 不变量：每次远端换歌最多 seek 一次；没有待对齐位置（控制端 / 同曲 / 已消费）时是 no-op。
   * 返回实际 seek 到的毫秒数，null 表示没有对齐动作（便于调用方与测试断言）。
   */
  alignAfterSwitch(): number | null {
    const target = this.pendingAlignMs
    if (target == null) return null
    this.pendingAlignMs = null
    this.applyingRemote = true
    try { this.player.seek(target) } finally { this.applyingRemote = false }
    this.emit({ type: 'applied', action: 'seek', positionMs: target })
    return target
  }

  // ------------------------------------------------ 控制端：本地 → 房间

  notifyPlay(): void {
    this.canSendTransport() && this.client.play()
  }

  notifyPause(): void {
    this.canSendTransport() && this.client.pause()
  }

  notifySeek(positionMs?: number): void {
    this.canSendTransport() && this.client.seek(positionMs ?? this.player.positionMs())
  }

  notifyTrackChanged(track?: TrackRef, index?: number): void {
    if (!this.isSendingAllowed()) return
    const target = track ?? this.player.currentTrack()
    if (!target) return
    this.client.setTrack(target, index)
    this.emit({ type: 'track_changed', track: target, remote: false })
  }

  notifyMode(mode: PlaybackMode): void {
    this.isSendingAllowed() && this.client.setMode(mode)
  }

  notifyFinished(): void {
    this.isSendingAllowed() && this.client.notifyTrackFinished()
  }

  /** 成员端：走 REQUEST_* */
  requestPlay(): void { this.client.requestPlay() }
  requestPause(): void { this.client.requestPause() }
  requestSeek(positionMs?: number): void { this.client.requestSeek(positionMs ?? this.player.positionMs()) }

  /**
   * 播放/暂停/进度：房主与成员都能按（一起听是共享歌单）。
   * 唯一例外是「正在应用远端状态」，否则自己按下的动作会被远端广播回环再执行一次。
   */
  private canSendTransport(): boolean {
    return !this.applyingRemote
  }

  /** 切歌/改模式会动队列语义：只有控制端能改，其余走 request* */
  private isSendingAllowed(): boolean {
    if (this.applyingRemote) return false
    return this.client.isController
  }

  /** 成员端正在应用远端状态时不要把回环动作再发出去 */
  isApplyingRemote(): boolean {
    return this.applyingRemote
  }

  private emitAndPush(list: RoomSessionEvent[], event: RoomSessionEvent): void {
    list.push(event)
    this.emit(event)
  }

  private emit(event: RoomSessionEvent): void {
    this.onEvent?.(event)
  }
}
