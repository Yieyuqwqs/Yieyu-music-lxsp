/**
 * ListeningRoomDO —— 一个房间一个 Durable Object。
 *
 * 关键实现点（对应需求）：
 * - 接入：`ctx.acceptWebSocket(server, [memberId])`，成员身份靠 tag 携带
 * - 广播：`ctx.getWebSockets()` 遍历，全部走 hibernation-safe handler
 * - 心跳：`ctx.setWebSocketAutoResponse(WebSocketRequestResponsePair('ping','pong'))`，不唤醒 DO
 * - 状态：`ctx.storage.put('room', state)`，10 秒 alarm 广播完整锚点
 * - 权限：CONTROLLER 直控；LISTENER 只能 REQUEST_*，且要过房间策略 + 房主在线 + trackStableKey
 * - 音频：永远不经过这里；三类直链候选只在内存里存，切歌/散会即清
 */
import {
  defaultSettings, emptyPlayback, isControlType, isRequestType, trackStableKey,
  type ClientMessage, type ErrorCode, type JoinRoomResponse, type MemberRole, type MemberState,
  type PlaybackMode, type RoomSnapshot, type RoomState, type ServerMessage, type TrackRef,
} from './protocol'
import { anchorForPause, anchorForPlay, anchorForSeek, anchorForSetTrack, playheadAt } from './clock'

interface Env {
  // 目前房间完全自足，没有外部绑定
  [key: string]: unknown
}

/** Workers 里 101 能带 webSocket；node 的 Response 不允许 101，单测退回朴素对象 */
const upgradeResponse = (client: unknown): Response => {
  try {
    return new Response(null, { status: 101, webSocket: client } as never)
  } catch (error) {
    return { status: 101, webSocket: client } as unknown as Response
  }
}

const STORAGE_KEY = 'room'
const SECRET_KEY_PREFIX = 'secret:'
const BROADCAST_INTERVAL_MS = 10_000
const MAX_CANDIDATES = 3

interface WebSocketLike {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  readyState?: number
}

export class ListeningRoomDO {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  private state: RoomState | null = null
  /** memberId → 直链候选（最多 3 条），只活在这个会话里，不落盘 */
  private readonly candidates = new Map<string, string[]>()

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
    // 心跳交给运行时：ping/pong 不唤醒 DO，省钱也稳
    if (typeof ctx.setWebSocketAutoResponse === 'function') {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    }
  }

  // ---------------------------------------------------------------- 状态

  private now(): number {
    return Date.now()
  }

  private async load(): Promise<RoomState> {
    if (this.state) return this.state
    const stored = await this.ctx.storage.get<RoomState>(STORAGE_KEY)
    if (stored) {
      // 重启后成员一律先按离线处理，等他们重连
      this.state = {
        ...stored,
        members: stored.members.map(member => ({ ...member, online: false })),
      }
      return this.state
    }
    const roomId = (this.ctx.id as unknown as { toString: () => string }).toString()
    this.state = {
      roomId,
      playback: emptyPlayback(),
      queue: [],
      currentIndex: -1,
      playbackMode: 'sequential',
      members: [],
      settings: defaultSettings(),
      updatedAt: this.now(),
    }
    return this.state
  }

  private async persist(): Promise<void> {
    if (!this.state) return
    this.state.updatedAt = this.now()
    await this.ctx.storage.put(STORAGE_KEY, this.state)
  }

  // ---------------------------------------------------------------- 广播

  private sockets(): WebSocketLike[] {
    return (this.ctx.getWebSockets?.() ?? []) as WebSocketLike[]
  }

  private memberIdOf(ws: WebSocketLike): string | null {
    const tags = (this.ctx as unknown as { getTags?: (ws: WebSocketLike) => string[] }).getTags?.(ws) ?? []
    return tags[0] ?? null
  }

  private send(ws: WebSocketLike, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message))
    } catch (error) {
      // 对端已经断了：忽略，close 事件会负责把成员标离线
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const ws of this.sockets()) this.send(ws, message)
  }

  /** 完整快照 + 服务端时间，客户端据此校准播放头 */
  private broadcastState(): void {
    if (!this.state) return
    this.broadcast({ type: 'room_state_updated', state: this.state, serverNow: this.now() })
  }

  private async ensureAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null) await this.ctx.storage.setAlarm(this.now() + BROADCAST_INTERVAL_MS)
  }

  async alarm(): Promise<void> {
    const state = await this.load()
    // 清掉长时间没心跳的成员（离线 2 分钟以上直接移除）
    const cutoff = this.now() - 120_000
    const online = new Set(this.sockets().map(ws => this.memberIdOf(ws)).filter(Boolean) as string[])
    let changed = false
    for (const member of state.members) {
      const isOnline = online.has(member.memberId)
      if (member.online !== isOnline) {
        member.online = isOnline
        changed = true
      }
      if (!isOnline && member.lastSeenAt < cutoff) member.online = false
    }
    if (changed) await this.persist()
    this.broadcastState()
    await this.ctx.storage.setAlarm(this.now() + BROADCAST_INTERVAL_MS)
  }

  // ---------------------------------------------------------------- HTTP / WS 接入

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const state = await this.load()

    if (url.pathname === '/init' && request.method === 'POST') {
      const roomId = url.searchParams.get('roomId')
      if (roomId && roomId !== state.roomId) {
        state.roomId = roomId
        await this.persist()
      }
      return Response.json({ ok: true, data: { roomId: state.roomId } })
    }

    if (url.pathname === '/snapshot') {
      const snapshot: RoomSnapshot = { state, serverNow: this.now() }
      return Response.json({ ok: true, data: snapshot })
    }

    if (url.pathname === '/join' && request.method === 'POST') {
      const body = await safeJson<{ memberSecret?: string, role?: MemberRole }>(request)
      const memberId = crypto.randomUUID()
      const memberSecret = body?.memberSecret || crypto.randomUUID()
      const role: MemberRole = body?.role === 'LISTENER' ? 'LISTENER' : (this.hasController(state) ? 'LISTENER' : 'CONTROLLER')
      await this.addMember(state, { memberId, role, online: false, joinedAt: this.now(), lastSeenAt: this.now() })
      await this.ctx.storage.put(SECRET_KEY_PREFIX + memberId, memberSecret)
      const response: JoinRoomResponse = {
        roomId: state.roomId,
        memberId,
        role,
        memberSecret,
        wsUrl: `${url.origin.replace(/^http/, 'ws')}/ws?memberId=${memberId}&memberSecret=${encodeURIComponent(memberSecret)}`,
      }
      return Response.json({ ok: true, data: response })
    }

    if (url.pathname === '/leave' && request.method === 'POST') {
      const body = await safeJson<{ memberId?: string }>(request)
      if (body?.memberId) await this.removeMember(state, body.memberId)
      return Response.json({ ok: true, data: { roomId: state.roomId } })
    }

    if (url.pathname === '/ws') {
      return this.handleUpgrade(request, url, state)
    }

    return Response.json({ ok: false, error: { code: 'not_found', message: 'no route: ' + url.pathname } }, { status: 404 })
  }

  private async handleUpgrade(request: Request, url: URL, state: RoomState): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return Response.json({ ok: false, error: { code: 'bad_request', message: 'expected websocket upgrade' } }, { status: 400 })
    }
    const memberId = url.searchParams.get('memberId') ?? ''
    const secret = url.searchParams.get('memberSecret') ?? ''
    const expected = memberId ? await this.ctx.storage.get<string>(SECRET_KEY_PREFIX + memberId) : null
    if (!memberId || !expected || expected !== secret) {
      return Response.json({ ok: false, error: { code: 'unauthorized', message: 'memberSecret 不匹配' } }, { status: 401 })
    }

    const member = state.members.find(item => item.memberId === memberId)
    if (!member) {
      return Response.json({ ok: false, error: { code: 'not_found', message: '成员不存在，请重新 join' } }, { status: 404 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    const serverWs = server ?? pair[1]
    this.ctx.acceptWebSocket(serverWs as never, [memberId])

    // 重连恢复角色：不因为断线就暂停，也不重排角色
    member.online = true
    member.lastSeenAt = this.now()
    if (!this.hasController(state) && member.role !== 'CONTROLLER') member.role = 'CONTROLLER'
    await this.persist()
    await this.ensureAlarm()

    this.send(serverWs as WebSocketLike, { type: 'room_state_updated', state, serverNow: this.now() })
    this.broadcast({ type: 'member_joined', memberId, role: member.role })
    this.broadcastState()
    return upgradeResponse(client)
  }

  // ---------------------------------------------------------------- 消息处理

  async webSocketMessage(ws: WebSocketLike, raw: string | ArrayBuffer): Promise<void> {
    const state = await this.load()
    const memberId = this.memberIdOf(ws)
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    let message: ClientMessage | null = null
    try {
      message = JSON.parse(text) as ClientMessage
    } catch (error) {
      this.send(ws, { type: 'error', code: 'bad_request', message: '消息不是合法 JSON' })
      return
    }
    if (!message || typeof (message as { type?: string }).type !== 'string') {
      this.send(ws, { type: 'error', code: 'bad_request', message: '缺少 type' })
      return
    }

    // 心跳 / 时钟同步：任何角色都能发
    if (message.type === 'np_ping') {
      this.send(ws, { type: 'np_pong', clientNow: message.clientNow, serverNow: this.now(), clientId: message.clientId })
      return
    }

    const member = memberId ? state.members.find(item => item.memberId === memberId) : null
    if (!member) {
      this.send(ws, { type: 'error', code: 'unauthorized', message: '未知成员' })
      return
    }
    member.lastSeenAt = this.now()
    member.online = true

    if (message.type === 'HEARTBEAT') {
      this.rememberPlayhead(state, message.positionMs)
      await this.persist()
      return
    }

    if (isRequestType(message.type)) {
      await this.handleRequest(ws, state, member, message)
      return
    }

    if (!isControlType(message.type)) {
      this.send(ws, { type: 'error', code: 'bad_request', message: `未知消息类型 ${message.type}` })
      return
    }

    if (member.role !== 'CONTROLLER') {
      this.send(ws, { type: 'error', code: 'forbidden', message: '只有控制端能直接控制' })
      return
    }

    await this.applyControl(state, message)
  }

  private async handleRequest(
    ws: WebSocketLike,
    state: RoomState,
    member: MemberState,
    message: Extract<ClientMessage, { type: `REQUEST_${string}` }>,
  ): Promise<void> {
    const requestType = message.type
    const reject = (reason: string) => {
      this.send(ws, { type: 'request_rejected', requestType, memberId: member.memberId, reason })
    }

    if (member.role === 'CONTROLLER') return reject('控制端直接发控制事件，不需要 REQUEST_*')
    if (!state.settings.allowListenerRequests) return reject('房间不允许成员请求')

    const controller = state.members.find(item => item.role === 'CONTROLLER')
    if (state.settings.requireHostOnline && !controller?.online) return reject('房主不在线')

    const requestedKey = (message as { requestTrackStableKey?: string }).requestTrackStableKey
    if (!requestedKey || requestedKey !== state.playback.trackStableKey) {
      return reject('requestTrackStableKey 与当前曲目不一致')
    }

    switch (requestType) {
      case 'REQUEST_PLAY':
        await this.applyControl(state, { type: 'PLAY' })
        break
      case 'REQUEST_PAUSE':
        await this.applyControl(state, { type: 'PAUSE' })
        break
      case 'REQUEST_SEEK':
        await this.applyControl(state, { type: 'SEEK', positionMs: (message as { positionMs: number }).positionMs })
        break
      case 'REQUEST_SET_TRACK':
        await this.applyControl(state, { type: 'SET_TRACK', track: (message as { track: TrackRef }).track })
        break
      default:
        return reject('不支持的请求')
    }
    this.broadcast({ type: 'request_acked', requestType, memberId: member.memberId })
  }

  private async applyControl(state: RoomState, message: Exclude<ClientMessage, { type: `REQUEST_${string}` }>): Promise<void> {
    const serverNow = this.now()
    switch (message.type) {
      case 'PLAY':
        if (!state.playback.trackStableKey) return
        state.playback = anchorForPlay(state.playback, serverNow)
        break
      case 'PAUSE':
        state.playback = anchorForPause(state.playback, serverNow)
        break
      case 'SEEK':
        state.playback = anchorForSeek(state.playback, serverNow, message.positionMs)
        break
      case 'SET_TRACK': {
        const index = message.index ?? state.queue.findIndex(item => item.stableKey === message.track.stableKey)
        if (index >= 0) state.currentIndex = index
        else {
          state.queue = [...state.queue, message.track]
          state.currentIndex = state.queue.length - 1
        }
        state.playback = anchorForSetTrack(state.playback, serverNow, message.track.stableKey)
        this.candidates.clear() // 换曲即丢弃直链候选
        break
      }
      case 'SET_QUEUE': {
        state.queue = message.queue.slice(0, 200)
        const index = message.currentIndex ?? -1
        state.currentIndex = index >= 0 && index < state.queue.length ? index : (state.queue.length ? 0 : -1)
        const track = state.queue[state.currentIndex]
        if (track) state.playback = anchorForSetTrack(state.playback, serverNow, track.stableKey)
        else {
          state.playback = { ...emptyPlayback(), anchorServerMs: serverNow }
          state.currentIndex = -1
        }
        this.candidates.clear()
        break
      }
      case 'PLAYBACK_MODE':
        state.playbackMode = message.mode
        break
      case 'TRACK_FINISHED': {
        if (message.trackStableKey !== state.playback.trackStableKey) return
        const next = this.nextTrackIndex(state)
        const track = next >= 0 ? state.queue[next] : null
        if (!track) {
          // 队列放完了：停在末尾，不自动续播
          state.playback = anchorForPause(state.playback, serverNow)
          break
        }
        state.currentIndex = next
        state.playback = anchorForSetTrack(state.playback, serverNow, track.stableKey)
        this.candidates.clear()
        break
      }
      default:
        return
    }
    await this.persist()
    this.broadcastState()
  }

  private nextTrackIndex(state: RoomState): number {
    const total = state.queue.length
    if (!total) return -1
    const current = state.currentIndex
    switch (state.playbackMode) {
      case 'singleLoop':
        return current >= 0 ? current : 0
      case 'listLoop':
        return (current + 1) % total
      case 'random': {
        if (total === 1) return 0
        let index = current
        while (index === current) index = Math.floor(Math.random() * total)
        return index
      }
      case 'sequential':
      default:
        return current + 1 < total ? current + 1 : -1
    }
  }

  /** 心跳里带的播放位置只做监控用，不覆盖锚点（避免客户端抖动污染权威状态） */
  private rememberPlayhead(state: RoomState, positionMs?: number): void {
    if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) return
    state.updatedAt = this.now()
  }

  // ---------------------------------------------------------------- 成员

  private hasController(state: RoomState): boolean {
    return state.members.some(member => member.role === 'CONTROLLER')
  }

  private async addMember(state: RoomState, member: MemberState): Promise<void> {
    if (state.members.filter(item => item.online).length >= state.settings.maxMembers) {
      throw new Error('room_full')
    }
    state.members = [...state.members.filter(item => item.memberId !== member.memberId), member]
    await this.persist()
  }

  private async removeMember(state: RoomState, memberId: string): Promise<void> {
    state.members = state.members.filter(item => item.memberId !== memberId)
    this.candidates.delete(memberId)
    await this.ctx.storage.delete(SECRET_KEY_PREFIX + memberId)
    await this.persist()
    this.broadcast({ type: 'member_left', memberId })
    this.broadcastState()
  }

  async webSocketClose(ws: WebSocketLike): Promise<void> {
    const state = await this.load()
    const memberId = this.memberIdOf(ws)
    if (!memberId) return
    const member = state.members.find(item => item.memberId === memberId)
    if (!member) return
    member.online = false
    member.lastSeenAt = this.now()
    this.candidates.delete(memberId)
    await this.persist()
    this.broadcast({ type: 'member_left', memberId })
    this.broadcastState()
  }

  async webSocketError(ws: WebSocketLike): Promise<void> {
    await this.webSocketClose(ws)
  }

  // ---------------------------------------------------------------- 直链候选（可选、不落盘）

  rememberCandidate(memberId: string, url: string): void {
    const list = this.candidates.get(memberId) ?? []
    const next = [url, ...list.filter(item => item !== url)].slice(0, MAX_CANDIDATES)
    this.candidates.set(memberId, next)
  }

  candidatesOf(memberId: string): string[] {
    return [...(this.candidates.get(memberId) ?? [])]
  }

  /** 会话结束：丢掉所有直链候选 */
  endSession(): void {
    this.candidates.clear()
  }
}

// ---- 小工具（DO 里也保持“坏输入不炸”）
async function safeJson<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text()
    if (!text) return null
    return JSON.parse(text) as T
  } catch (error) {
    return null
  }
}

export const errorResponse = (code: ErrorCode, message: string, status = 400): Response => (
  Response.json({ ok: false, error: { code, message } }, { status })
)
