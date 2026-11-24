/**
 * 一起听房间 · 协议定义（Worker 与客户端共用）
 *
 * 设计约束（来自需求）：
 * - 音频永远不经过服务端；服务端只管「谁在放什么、放到哪」
 * - 时间以「锚点」表达：playback = { positionMs, anchorServerMs, isPlaying }
 * - 客户端播放头 = positionMs + max(0, serverNow - anchorServerMs)（仅 isPlaying）
 * - 所有控制都是幂等的状态替换，不做「增量指令」
 */

export type MemberRole = 'CONTROLLER' | 'LISTENER'

export type PlaybackMode = 'sequential' | 'listLoop' | 'singleLoop' | 'random'

/** 曲目只留稳定标识 + 展示信息，直链由每个客户端自己向后端要 */
export interface TrackRef {
  /** 跨端稳定键：source:id，用来校验 REQUEST_* 是不是针对当前曲目 */
  stableKey: string
  id: string
  source: string
  name: string
  singer: string
  /** 毫秒；未知填 0 */
  durationMs: number
}

export interface PlaybackState {
  /** 锚点时刻的播放位置（毫秒） */
  positionMs: number
  /** 锚点对应的服务端时间（毫秒，epoch） */
  anchorServerMs: number
  isPlaying: boolean
  /** 当前曲目的 stableKey；空闲为 null */
  trackStableKey: string | null
}

export interface MemberState {
  memberId: string
  role: MemberRole
  online: boolean
  joinedAt: number
  lastSeenAt: number
}

export interface RoomSettings {
  /** 允许 LISTENER 发 REQUEST_* */
  allowListenerRequests: boolean
  /** 房主（CONTROLLER）离线时，LISTENER 的请求是否直接拒绝 */
  requireHostOnline: boolean
  maxMembers: number
}

export interface RoomState {
  roomId: string
  playback: PlaybackState
  queue: TrackRef[]
  currentIndex: number
  playbackMode: PlaybackMode
  members: MemberState[]
  settings: RoomSettings
  /** 状态版本号：每次变更 +1 */
  version: number
  /** 服务端最后改写时间 */
  updatedAt: number
}

/** 客户端 → 服务端 */
export type ControlType =
  | 'PLAY' | 'PAUSE' | 'SEEK' | 'SET_TRACK' | 'SET_QUEUE' | 'PLAYBACK_MODE'
  | 'HEARTBEAT' | 'TRACK_FINISHED'

export type RequestType = 'REQUEST_PLAY' | 'REQUEST_PAUSE' | 'REQUEST_SEEK' | 'REQUEST_SET_TRACK'

export type ClientMessage =
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'SEEK', positionMs: number }
  | { type: 'SET_TRACK', track: TrackRef, index?: number }
  | { type: 'SET_QUEUE', queue: TrackRef[], currentIndex?: number }
  | { type: 'PLAYBACK_MODE', mode: PlaybackMode }
  | { type: 'HEARTBEAT', positionMs?: number }
  | { type: 'TRACK_FINISHED', trackStableKey: string }
  | { type: 'REQUEST_PLAY', requestTrackStableKey: string }
  | { type: 'REQUEST_PAUSE', requestTrackStableKey: string }
  | { type: 'REQUEST_SEEK', requestTrackStableKey: string, positionMs: number }
  | { type: 'REQUEST_SET_TRACK', requestTrackStableKey: string, track: TrackRef }
  | { type: 'np_ping', clientNow: number, clientId?: string }

/** 服务端 → 客户端 */
export type ServerMessage =
  | { type: 'room_state_updated', state: RoomState, serverNow: number }
  | { type: 'np_pong', clientNow: number, serverNow: number, clientId?: string }
  | { type: 'request_acked', requestType: RequestType, memberId: string }
  | { type: 'request_rejected', requestType: RequestType, memberId: string, reason: string }
  | { type: 'error', code: ErrorCode, message: string }
  | { type: 'member_joined', memberId: string, role: MemberRole }
  | { type: 'member_left', memberId: string }

export type ErrorCode =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'room_full' | 'not_found' | 'internal'

/** HTTP 信封：与 LXSP 保持同一套形状，前端不用记两种 */
export interface ApiOk<T> { ok: true, data: T }
export interface ApiErr { ok: false, error: { code: ErrorCode, message: string } }
export type ApiEnvelope<T> = ApiOk<T> | ApiErr

export interface CreateRoomResponse { roomId: string }
export interface JoinRoomResponse { roomId: string, memberId: string, role: MemberRole, memberSecret: string, wsUrl: string }
export interface RoomSnapshot { state: RoomState, serverNow: number }

export const CONTROL_TYPES: ControlType[] = [
  'PLAY', 'PAUSE', 'SEEK', 'SET_TRACK', 'SET_QUEUE', 'PLAYBACK_MODE', 'HEARTBEAT', 'TRACK_FINISHED',
]

export const REQUEST_TYPES: RequestType[] = [
  'REQUEST_PLAY', 'REQUEST_PAUSE', 'REQUEST_SEEK', 'REQUEST_SET_TRACK',
]

export const isControlType = (type: string): type is ControlType => (CONTROL_TYPES as string[]).includes(type)
export const isRequestType = (type: string): type is RequestType => (REQUEST_TYPES as string[]).includes(type)

/** 由 source + id 生成稳定键（客户端与服务端必须一致） */
export const trackStableKey = (source: string, id: string): string => `${source}:${id}`

export const emptyPlayback = (): PlaybackState => ({
  positionMs: 0,
  anchorServerMs: 0,
  isPlaying: false,
  trackStableKey: null,
})

export const defaultSettings = (): RoomSettings => ({
  allowListenerRequests: true,
  requireHostOnline: true,
  maxMembers: 8,
})
