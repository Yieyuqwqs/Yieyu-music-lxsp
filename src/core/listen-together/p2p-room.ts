/**
 * 零部署房间：用公共 MQTT broker 当传输层，房主的客户端就是「权威服务端」。
 *
 *   topic: lx-listen/<roomId>
 *   房主：任何本地操作 → 自己算锚点 → 广播 room_state_updated；每 10 秒补发一次；回 np_pong
 *   成员：订阅 topic → 收 state 就对齐播放 → REQUEST_* 发给房主，房主校验后再广播
 *
 * 协议字段与 Cloudflare/local 版本完全一致，所以 RoomSession 那层不用改。
 */
import { MqttClient, DEFAULT_BROKER } from './mqtt'
import { anchorForPause, anchorForPlay, anchorForSeek, anchorForSetTrack, emptyClockSync, localPlayhead, mergePong, type ClockSync } from './playhead'
import {
  emptyPlayback, defaultSettings, type PlaybackMode, type RoomState, type ServerMessage, type TrackRef,
} from './protocol'

export type P2PRole = 'host' | 'guest'

export interface P2PRoomOptions {
  roomId: string
  role: P2PRole
  brokerUrl?: string
  memberId?: string
  onState?: (state: RoomState, serverNow: number) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onRejected?: (requestType: string, reason: string) => void
  onError?: (message: string) => void
}

const BROADCAST_MS = 10_000

export const topicOf = (roomId: string): string => `lx-listen/${roomId}`

export class P2PRoom {
  readonly roomId: string
  readonly role: P2PRole
  readonly memberId: string
  private readonly options: P2PRoomOptions
  private readonly mqtt: MqttClient
  private state: RoomState
  private broadcastTimer: ReturnType<typeof setInterval> | null = null
  private clockTimer: ReturnType<typeof setInterval> | null = null
  private clockSync: ClockSync = emptyClockSync()
  private lastPingAt = 0
  private closed = false

  constructor(options: P2PRoomOptions) {
    this.options = options
    this.roomId = options.roomId
    this.role = options.role
    this.memberId = options.memberId ?? `m-${Math.random().toString(16).slice(2, 10)}`
    this.state = {
      roomId: options.roomId,
      playback: emptyPlayback(),
      queue: [],
      currentIndex: -1,
      playbackMode: 'sequential',
      members: [{ memberId: this.memberId, role: this.role === 'host' ? 'CONTROLLER' : 'LISTENER', online: true, joinedAt: Date.now(), lastSeenAt: Date.now() }],
      settings: defaultSettings(),
      updatedAt: Date.now(),
    }
    this.mqtt = new MqttClient({
      url: options.brokerUrl ?? DEFAULT_BROKER,
      clientId: `lx-${options.roomId}-${this.memberId}`.slice(0, 60),
      onConnect: () => {
        this.mqtt.subscribe(topicOf(this.roomId))
        this.options.onConnected?.()
        if (this.role === 'host') {
          this.broadcastState()
          this.startBroadcast()
        } else {
          // 成员：先把时钟校准起来，再持续采样（公共 broker 的往返也算进去）
          this.pingClock()
          this.pingClock()
          if (!this.clockTimer) {
            this.clockTimer = setInterval(() => this.pingClock(), 8_000)
          }
        }
      },
      onClose: () => this.options.onDisconnected?.(),
      onMessage: (topic, payload) => this.handleMessage(topic, payload),
      onError: (error) => this.options.onError?.(error.message),
    })
  }

  start(): void {
    this.mqtt.connect()
  }

  close(): void {
    this.closed = true
    if (this.broadcastTimer) clearInterval(this.broadcastTimer)
    this.broadcastTimer = null
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.clockTimer = null
    this.mqtt.close()
  }

  get currentState(): RoomState {
    return this.state
  }

  // ---------------------------------------------------------- 房主：本地操作 → 广播

  private startBroadcast(): void {
    if (this.broadcastTimer) return
    this.broadcastTimer = setInterval(() => {
      if (this.role !== 'host') return
      this.pruneMembers()
      this.broadcastState()
    }, BROADCAST_MS)
  }

  private broadcastState(): void {
    if (this.role !== 'host') return
    const message: ServerMessage = { type: 'room_state_updated', state: this.state, serverNow: Date.now() }
    this.mqtt.publish(topicOf(this.roomId), JSON.stringify(message))
    this.options.onState?.(this.state, Date.now())
  }

  private applyControl(type: string, payload: Partial<TrackRef> & { positionMs?: number, mode?: PlaybackMode, track?: TrackRef, queue?: TrackRef[], currentIndex?: number, trackStableKey?: string }): boolean {
    if (this.role !== 'host') return false
    const serverNow = Date.now()
    const playback = this.state.playback
    switch (type) {
      case 'PLAY':
        if (!playback.trackStableKey) return false
        this.state.playback = anchorForPlay(playback, serverNow)
        break
      case 'PAUSE':
        this.state.playback = anchorForPause(playback, serverNow)
        break
      case 'SEEK':
        this.state.playback = anchorForSeek(playback, serverNow, Number(payload.positionMs) || 0)
        break
      case 'SET_TRACK': {
        const track = payload.track
        if (!track) return false
        const index = this.state.queue.findIndex(item => item.stableKey === track.stableKey)
        if (index >= 0) this.state.currentIndex = index
        else { this.state.queue = [...this.state.queue, track]; this.state.currentIndex = this.state.queue.length - 1 }
        this.state.playback = anchorForSetTrack(playback, serverNow, track.stableKey)
        break
      }
      case 'SET_QUEUE': {
        const queue = (payload.queue ?? []).slice(0, 200)
        this.state.queue = queue
        this.state.currentIndex = queue.length ? Math.max(0, Math.min(queue.length - 1, Number(payload.currentIndex) || 0)) : -1
        const track = queue[this.state.currentIndex]
        this.state.playback = track ? anchorForSetTrack(playback, serverNow, track.stableKey) : { ...emptyPlayback(), anchorServerMs: serverNow }
        break
      }
      case 'PLAYBACK_MODE':
        if (!payload.mode) return false
        this.state.playbackMode = payload.mode
        break
      case 'TRACK_FINISHED': {
        if (payload.trackStableKey !== playback.trackStableKey) return false
        const total = this.state.queue.length
        const current = this.state.currentIndex
        let next = current + 1 < total ? current + 1 : -1
        if (this.state.playbackMode === 'singleLoop') next = current
        else if (this.state.playbackMode === 'listLoop') next = total ? (current + 1) % total : -1
        else if (this.state.playbackMode === 'random') next = total > 1 ? (current + 1 + Math.floor(Math.random() * (total - 1))) % total : current
        const track = next >= 0 ? this.state.queue[next] : null
        if (track) { this.state.currentIndex = next; this.state.playback = anchorForSetTrack(playback, serverNow, track.stableKey) }
        else this.state.playback = anchorForPause(playback, serverNow)
        break
      }
      default:
        return false
    }
    this.state.updatedAt = serverNow
    return true
  }

  /** 控制端（房主）用：改状态并广播 */
  control(type: string, payload: Record<string, unknown> = {}): void {
    if (this.applyControl(type, payload as never)) this.broadcastState()
  }

  // ---------------------------------------------------------- 成员：请求

  request(type: 'REQUEST_PLAY' | 'REQUEST_PAUSE' | 'REQUEST_SEEK' | 'REQUEST_SET_TRACK', extra: Record<string, unknown> = {}): void {
    if (this.role === 'host') {
      // 房主自己就是权威，直接执行
      const mapping: Record<string, string> = { REQUEST_PLAY: 'PLAY', REQUEST_PAUSE: 'PAUSE', REQUEST_SEEK: 'SEEK', REQUEST_SET_TRACK: 'SET_TRACK' }
      this.control(mapping[type], extra)
      return
    }
    this.mqtt.publish(topicOf(this.roomId), JSON.stringify({
      type,
      memberId: this.memberId,
      requestTrackStableKey: this.state.playback.trackStableKey,
      ...extra,
    }))
  }

  // ---------------------------------------------------------- 收发

  private handleMessage(topic: string, payload: string): void {
    if (topic !== topicOf(this.roomId) || this.closed) return
    let message: Record<string, unknown> & { type?: string }
    try { message = JSON.parse(payload) } catch (error) { return }
    if (!message?.type) return

    // 房主：谁发消息来，谁就是成员（p2p 没有服务端登记，只能靠这一手）
    if (this.role === 'host') {
      const peerId = typeof message.from === 'string' ? message.from : (typeof message.memberId === 'string' ? message.memberId : null)
      if (peerId && peerId !== this.memberId) this.touchMember(peerId)
    }

    // 时钟：房主用自己时间回 pong；成员拿 pong 校准
    if (message.type === 'np_ping') {
      if (this.role === 'host') {
        this.mqtt.publish(topicOf(this.roomId), JSON.stringify({ type: 'np_pong', clientNow: message.clientNow, serverNow: Date.now(), to: message.from }))
      }
      return
    }

    // 房主：处理成员请求
    if (this.role === 'host' && String(message.type).startsWith('REQUEST_')) {
      const requestedKey = message.requestTrackStableKey
      if (requestedKey !== this.state.playback.trackStableKey) {
        this.mqtt.publish(topicOf(this.roomId), JSON.stringify({ type: 'request_rejected', requestType: message.type, memberId: message.memberId, reason: 'requestTrackStableKey 与当前曲目不一致' }))
        return
      }
      const mapping: Record<string, string> = { REQUEST_PLAY: 'PLAY', REQUEST_PAUSE: 'PAUSE', REQUEST_SEEK: 'SEEK', REQUEST_SET_TRACK: 'SET_TRACK' }
      const controlType = mapping[String(message.type)]
      if (!controlType) return
      this.control(controlType, message as never)
      this.mqtt.publish(topicOf(this.roomId), JSON.stringify({ type: 'request_acked', requestType: message.type, memberId: message.memberId }))
      return
    }

    if (message.type === 'np_pong' && this.role === 'guest') {
      const clientNow = Number(message.clientNow)
      const serverNow = Number(message.serverNow)
      if (Number.isFinite(clientNow) && Number.isFinite(serverNow)) {
        this.clockSync = mergePong(this.clockSync, clientNow, Date.now(), serverNow)
      }
      return
    }

    // 成员：应用房主广播的状态
    if (message.type === 'room_state_updated' && this.role === 'guest') {
      const state = message.state as RoomState
      if (!state?.playback) return
      this.state = state
      this.options.onState?.(state, Number(message.serverNow) || Date.now())
      return
    }

    if (message.type === 'request_rejected' && this.role === 'guest') {
      if (message.memberId && message.memberId !== this.memberId) return
      this.options.onRejected?.(String(message.requestType), String(message.reason))
    }
  }

  /** 房主维护成员表：新面孔加进来，久没动静的标离线 */
  private touchMember(memberId: string): void {
    const existing = this.state.members.find(item => item.memberId === memberId)
    if (existing) {
      existing.online = true
      existing.lastSeenAt = Date.now()
      this.broadcastState()
      return
    }
    this.state.members = [...this.state.members, {
      memberId,
      role: 'LISTENER',
      online: true,
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
    }]
    this.broadcastState()
  }

  private pruneMembers(): void {
    const cutoff = Date.now() - 30_000
    let changed = false
    for (const member of this.state.members) {
      if (member.memberId === this.memberId) continue
      const stale = member.lastSeenAt < cutoff
      if (stale && member.online) { member.online = false; changed = true }
    }
    if (changed) this.broadcastState()
  }

  /** 成员发时钟探测（房主会回 np_pong） */
  pingClock(): void {
    if (this.role === 'host') return
    this.lastPingAt = Date.now()
    this.mqtt.publish(topicOf(this.roomId), JSON.stringify({ type: 'np_ping', clientNow: this.lastPingAt, from: this.memberId }))
  }

  get clock(): ClockSync {
    return { ...this.clockSync }
  }

  /** 当前应该播放到哪儿（成员用校准后的时间；房主直接用本地时间） */
  playheadMs(): number {
    if (this.role === 'host') return localPlayhead(this.state.playback, Date.now(), emptyClockSync())
    return localPlayhead(this.state.playback, Date.now(), this.clockSync)
  }
}

/** 生成一个随机的房号（够随机，等于房间口令） */
export const makeRoomId = (): string => {
  const alphabet = '0123456789abcdefghjkmnpqrstuvwxyz'
  let out = ''
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}
