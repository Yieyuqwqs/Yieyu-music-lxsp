/**
 * 一起听客户端
 *
 * 职责边界：
 * - 房间状态只做「镜像」：服务端广播什么就是什么，客户端不推断权威状态
 * - 播放头由本地时钟 + 最小 RTT 校准算出，音频本身仍然走各自的 LXSP 端点
 * - 断线用 memberSecret 重连，恢复角色、不主动发 PAUSE
 */
import { emptyClockSync, localPlayhead, mergePong, serverNowOf, type ClockSync } from './playhead'
import { trackStableKey, type ClientMessage, type JoinResult, type PlaybackMode, type RoomState, type ServerMessage, type TrackRef } from './protocol'
import { reportError } from '@/core/listen-together/errors'

export type ListenTogetherEvent =
  | { type: 'open' }
  | { type: 'close', code?: number }
  | { type: 'state', state: RoomState, serverNow: number }
  | { type: 'acked', requestType: string }
  | { type: 'rejected', requestType: string, reason: string }
  | { type: 'error', code: string, message: string }
  | { type: 'reconnecting', attempt: number }

interface WebSocketLike {
  readyState?: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  onopen?: (() => void) | null
  onclose?: ((event?: { code?: number }) => void) | null
  onmessage?: ((event: { data: unknown }) => void) | null
  onerror?: ((event?: unknown) => void) | null
}

export interface ListenTogetherOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** 单测可注入假 WebSocket */
  wsFactory?: (url: string) => WebSocketLike
  now?: () => number
  /** np_ping 间隔，默认 5s */
  pingIntervalMs?: number
  /** HTTP 超时，默认 10s（workers.dev 在部分网络里会直接挂住） */
  requestTimeoutMs?: number
  /** 重连退避上限，默认 8s */
  maxBackoffMs?: number
}

interface PendingMeta {
  clientNow: number
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '')

export class ListenTogetherClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly wsFactory: (url: string) => WebSocketLike
  private readonly now: () => number
  private readonly pingIntervalMs: number
  private readonly maxBackoffMs: number
  private readonly requestTimeoutMs: number

  private ws: WebSocketLike | null = null
  private session: JoinResult | null = null
  private state: RoomState | null = null
  private clockSync: ClockSync = emptyClockSync()
  private listeners = new Set<(event: ListenTogetherEvent) => void>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private manualClose = false
  private reconnectAttempt = 0
  private lastPing: PendingMeta | null = null

  constructor(options: ListenTogetherOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl)
    const fetchImpl = options.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch
    if (!fetchImpl) throw new Error('环境里没有 fetch')
    this.fetchImpl = fetchImpl
    this.wsFactory = options.wsFactory ?? (url => new (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket(url))
    this.now = options.now ?? Date.now
    this.pingIntervalMs = options.pingIntervalMs ?? 5000
    this.maxBackoffMs = options.maxBackoffMs ?? 8000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  }

  // ------------------------------------------------------------ 事件

  on(handler: (event: ListenTogetherEvent) => void): () => void {
    this.listeners.add(handler)
    return () => { this.listeners.delete(handler) }
  }

  private emit(event: ListenTogetherEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { reportError('client:emit', error) }
    }
  }

  // ------------------------------------------------------------ HTTP

  private async call<T>(path: string, body?: unknown): Promise<T> {
    // 手机网络对 workers.dev 这类域名可能直接挂住：必须自己加超时，否则 UI 会永远「处理中」
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), this.requestTimeoutMs) : null
    let response: Awaited<ReturnType<typeof fetch>>
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      })
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError'
      throw Object.assign(new Error(aborted ? `请求超时（${this.requestTimeoutMs}ms）` : `连不上服务器：${(error as Error).message}`), { code: aborted ? 'timeout' : 'network' })
    } finally {
      if (timer) clearTimeout(timer)
    }
    const payload = await response.json().catch(() => null) as { ok?: boolean, data?: T, error?: { code: string, message: string } } | null
    if (!payload || payload.ok !== true || payload.data === undefined) {
      const code = payload?.error?.code ?? 'http_' + response.status
      const message = payload?.error?.message ?? '请求失败'
      throw Object.assign(new Error(message), { code })
    }
    return payload.data
  }

  async createRoom(): Promise<string> {
    const data = await this.call<{ roomId: string }>('/api/rooms', {})
    return data.roomId
  }

  async joinRoom(roomId: string): Promise<JoinResult> {
    const data = await this.call<JoinResult>(`/api/rooms/${roomId}/join`, {})
    this.session = data
    return data
  }

  async fetchState(roomId: string): Promise<{ state: RoomState, serverNow: number }> {
    return this.call<{ state: RoomState, serverNow: number }>(`/api/rooms/${roomId}/state`)
  }

  async leave(roomId: string): Promise<void> {
    if (this.session) {
      await this.call(`/api/rooms/${roomId}/leave`, { memberId: this.session.memberId }).catch(() => {})
    }
    this.disconnect()
    this.session = null
    this.state = null
  }

  // ------------------------------------------------------------ WebSocket

  /** 连接并开始心跳；断线自动用 memberSecret 重连 */
  connect(session?: JoinResult): WebSocketLike {
    const target = session ?? this.session
    if (!target) throw new Error('还没有 join 结果')
    this.session = target
    this.manualClose = false
    const ws = this.wsFactory(target.wsUrl)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempt = 0
      this.emit({ type: 'open' })
      this.startPing()
    }

    ws.onmessage = (event) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data)
      let message: ServerMessage | null = null
      try { message = JSON.parse(text) as ServerMessage } catch (error) { return }
      this.handleMessage(message)
    }

    ws.onclose = (event) => {
      this.stopPing()
      this.emit({ type: 'close', code: event?.code })
      if (this.manualClose) return
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // 具体原因由 close 兜底
    }

    return ws
  }

  private scheduleReconnect(): void {
    if (!this.session) return
    this.reconnectAttempt += 1
    const delay = Math.min(this.maxBackoffMs, 250 * Math.pow(2, this.reconnectAttempt - 1))
    this.emit({ type: 'reconnecting', attempt: this.reconnectAttempt })
    setTimeout(() => {
      if (this.manualClose || !this.session) return
      this.connect(this.session)
    }, delay)
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'room_state_updated':
        this.state = message.state
        this.emit({ type: 'state', state: message.state, serverNow: message.serverNow })
        break
      case 'np_pong': {
        const deviceNow = this.now()
        this.clockSync = mergePong(this.clockSync, message.clientNow, deviceNow, message.serverNow)
        break
      }
      case 'request_acked':
        this.emit({ type: 'acked', requestType: message.requestType })
        break
      case 'request_rejected':
        this.emit({ type: 'rejected', requestType: message.requestType, reason: message.reason })
        break
      case 'error':
        this.emit({ type: 'error', code: message.code, message: message.message })
        break
      default:
        break
    }
  }

  disconnect(): void {
    this.manualClose = true
    this.stopPing()
    if (this.ws) {
      try { this.ws.close(1000, 'client leave') } catch (error) { reportError('client:close', error) }
      this.ws = null
    }
  }

  // ------------------------------------------------------------ 时钟

  private startPing(): void {
    this.stopPing()
    this.pingOnce()
    this.pingTimer = setInterval(() => this.pingOnce(), this.pingIntervalMs)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  /** 发一次 np_ping（单测可直接调） */
  pingOnce(): void {
    if (!this.ws) return
    const clientNow = this.now()
    this.lastPing = { clientNow }
    this.sendRaw({ type: 'np_ping', clientNow })
  }

  get clock(): ClockSync {
    return { ...this.clockSync }
  }

  get roomState(): RoomState | null {
    return this.state
  }

  get sessionInfo(): JoinResult | null {
    return this.session
  }

  /** 当前应该播放到的位置（毫秒） */
  playheadMs(): number {
    if (!this.state) return 0
    return localPlayhead(this.state.playback, this.now(), this.clockSync)
  }

  /** 服务端时间估计（调试/展示用） */
  serverNowMs(): number {
    return serverNowOf(this.now(), this.clockSync)
  }

  get isController(): boolean {
    return this.state?.members.find(member => member.memberId === this.session?.memberId)?.role === 'CONTROLLER'
  }

  // ------------------------------------------------------------ 发送

  private sendRaw(message: ClientMessage): void {
    if (!this.ws) return
    try { this.ws.send(JSON.stringify(message)) } catch (error) { reportError('client:send', error) }
  }

  // 控制端
  play(): void { this.sendRaw({ type: 'PLAY' }) }
  pause(): void { this.sendRaw({ type: 'PAUSE' }) }
  seek(positionMs: number): void { this.sendRaw({ type: 'SEEK', positionMs: Math.max(0, Math.floor(positionMs)) }) }
  setQueue(queue: TrackRef[], currentIndex?: number): void { this.sendRaw({ type: 'SET_QUEUE', queue, currentIndex }) }
  setTrack(track: TrackRef, index?: number): void { this.sendRaw({ type: 'SET_TRACK', track, index }) }
  setMode(mode: PlaybackMode): void { this.sendRaw({ type: 'PLAYBACK_MODE', mode }) }
  heartbeat(positionMs?: number): void { this.sendRaw({ type: 'HEARTBEAT', positionMs }) }
  notifyTrackFinished(): void {
    const key = this.state?.playback.trackStableKey
    if (key) this.sendRaw({ type: 'TRACK_FINISHED', trackStableKey: key })
  }

  // 成员端：自动带当前曲目的 stableKey，省得调用方自己拼
  requestPlay(): void { this.sendRequest({ type: 'REQUEST_PLAY' }) }
  requestPause(): void { this.sendRequest({ type: 'REQUEST_PAUSE' }) }
  requestSeek(positionMs: number): void { this.sendRequest({ type: 'REQUEST_SEEK', positionMs: Math.max(0, Math.floor(positionMs)) }) }
  requestSetTrack(track: TrackRef): void { this.sendRequest({ type: 'REQUEST_SET_TRACK', track }) }

  private sendRequest(message: { type: 'REQUEST_PLAY' | 'REQUEST_PAUSE' | 'REQUEST_SEEK' | 'REQUEST_SET_TRACK', positionMs?: number, track?: TrackRef }): void {
    const key = this.state?.playback.trackStableKey
    if (!key) {
      this.emit({ type: 'error', code: 'bad_request', message: '房间里还没有曲目' })
      return
    }
    this.sendRaw({ ...message, requestTrackStableKey: key } as ClientMessage)
  }

  /** 从 app 的歌曲对象生成 TrackRef（统一 stableKey 规则） */
  static toTrackRef(input: { id?: string, songId?: string, source: string, name: string, singer?: string, interval?: string, durationMs?: number }): TrackRef {
    const id = String(input.id ?? input.songId ?? '')
    return {
      stableKey: trackStableKey(input.source, id),
      id,
      source: input.source,
      name: input.name,
      singer: input.singer ?? '',
      durationMs: input.durationMs ?? parseInterval(input.interval),
    }
  }
}

const parseInterval = (interval?: string): number => {
  if (!interval) return 0
  const parts = interval.split(':').map(part => Number.parseInt(part, 10)).filter(part => Number.isFinite(part))
  if (!parts.length) return 0
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return seconds * 1000
}
