/**
 * 一起听 · 线格式（与 cloud/listening-room/src/protocol.ts 保持一致）
 *
 * 客户端只关心「状态 → 播放头」这一件事，音频永远不经过服务端。
 */

export type MemberRole = 'CONTROLLER' | 'LISTENER'
export type PlaybackMode = 'sequential' | 'listLoop' | 'singleLoop' | 'random'

export interface TrackRef {
  stableKey: string
  id: string
  source: string
  name: string
  singer: string
  durationMs: number
}

export interface PlaybackState {
  positionMs: number
  anchorServerMs: number
  isPlaying: boolean
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
  allowListenerRequests: boolean
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
  updatedAt: number
}

export interface JoinResult {
  roomId: string
  memberId: string
  role: MemberRole
  memberSecret: string
  wsUrl: string
}

export type ClientMessage =
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'SEEK', positionMs: number }
  | { type: 'SET_TRACK', track: TrackRef, index?: number }
  | { type: 'SET_QUEUE', queue: TrackRef[], currentIndex?: number }
  /** 任何人往共享队列里加歌 —— 一起听的核心：不是各听各的本地列表 */
  | { type: 'QUEUE_ADD', tracks: TrackRef[] }
  /** 任何人从共享队列里删歌 */
  | { type: 'QUEUE_REMOVE', stableKey: string }
  | { type: 'PLAYBACK_MODE', mode: PlaybackMode }
  | { type: 'HEARTBEAT', positionMs?: number }
  | { type: 'TRACK_FINISHED', trackStableKey: string }
  | { type: 'REQUEST_PLAY', requestTrackStableKey: string }
  | { type: 'REQUEST_PAUSE', requestTrackStableKey: string }
  | { type: 'REQUEST_SEEK', requestTrackStableKey: string, positionMs: number }
  | { type: 'REQUEST_SET_TRACK', requestTrackStableKey: string, track: TrackRef }
  | { type: 'np_ping', clientNow: number, clientId?: string }

export interface ServerStateMessage { type: 'room_state_updated', state: RoomState, serverNow: number }
export interface ServerPongMessage { type: 'np_pong', clientNow: number, serverNow: number, clientId?: string }
export interface ServerAckMessage { type: 'request_acked', requestType: string, memberId: string }
export interface ServerRejectMessage { type: 'request_rejected', requestType: string, memberId: string, reason: string }
export interface ServerErrorMessage { type: 'error', code: string, message: string }
export interface ServerMemberMessage { type: 'member_joined' | 'member_left', memberId: string, role?: MemberRole }

export type ServerMessage =
  | ServerStateMessage | ServerPongMessage | ServerAckMessage
  | ServerRejectMessage | ServerErrorMessage | ServerMemberMessage

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
