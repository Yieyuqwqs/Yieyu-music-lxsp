/**
 * 一起听 · 单例服务（App 侧唯一入口）
 *
 * 负责：读设置里的服务器地址 → 建房/加入 → 连 WS → 把状态交给 RoomSession 落到播放器。
 * 音频不经过任何房间服务：这里只同步「放什么、放到哪」。
 */
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { play, pause } from '@/core/player/player'
import { setCurrentTime } from '@/plugins/player/utils'
import { ListenTogetherClient } from './client'
import { RoomSession, type PlayerAdapter } from './room'
import type { JoinResult, RoomState } from './protocol'

export interface RoomStatus {
  connected: boolean
  roomId: string | null
  role: 'CONTROLLER' | 'LISTENER' | null
  memberId: string | null
  members: Array<{ memberId: string, role: string, online: boolean }>
  isPlaying: boolean
  positionMs: number
  state: RoomState | null
  lastError: string | null
}

const createPlayerAdapter = (): PlayerAdapter => ({
  play,
  pause: () => { void pause() },
  seek: (positionMs: number) => { void setCurrentTime(positionMs / 1000) },
  isPlaying: () => playerState.isPlay,
  positionMs: () => Math.max(0, playerState.progress.nowPlayTime * 1000),
  currentTrack: () => {
    const musicInfo = playerState.playMusicInfo.musicInfo
    if (!musicInfo) return null
    return ListenTogetherClient.toTrackRef({
      id: (musicInfo.meta as { songId?: string } | undefined)?.songId,
      source: musicInfo.source,
      name: musicInfo.name,
      singer: musicInfo.singer,
      interval: musicInfo.interval,
    })
  },
})

class ListenTogetherService {
  private client: ListenTogetherClient | null = null
  private session: RoomSession | null = null
  private status: RoomStatus = {
    connected: false, roomId: null, role: null, memberId: null,
    members: [], isPlaying: false, positionMs: 0, state: null, lastError: null,
  }
  private listeners = new Set<(status: RoomStatus) => void>()

  getStatus(): RoomStatus {
    return { ...this.status, members: [...this.status.members] }
  }

  subscribe(handler: (status: RoomStatus) => void): () => void {
    this.listeners.add(handler)
    handler(this.getStatus())
    return () => { this.listeners.delete(handler) }
  }

  private update(patch: Partial<RoomStatus>): void {
    this.status = { ...this.status, ...patch }
    const snapshot = this.getStatus()
    for (const listener of this.listeners) {
      try { listener(snapshot) } catch (error) { /* 忽略单个订阅者异常 */ }
    }
  }

  private serverUrl(): string {
    const raw = String(settingState.setting['common.listenTogetherServer'] ?? '').trim()
    if (!raw) throw new Error('先在设置里填一起听服务器地址')
    return raw
  }

  private ensureClient(): ListenTogetherClient {
    if (this.client) return this.client
    const client = new ListenTogetherClient({ baseUrl: this.serverUrl() })
    client.on((event) => {
      if (event.type === 'open') this.update({ connected: true, lastError: null })
      else if (event.type === 'close') this.update({ connected: false })
      else if (event.type === 'error') this.update({ lastError: event.message })
      else if (event.type === 'rejected') this.update({ lastError: `请求被拒：${event.reason}` })
      else if (event.type === 'state') {
        this.update({
          state: event.state,
          roomId: event.state.roomId,
          members: event.state.members.map(m => ({ memberId: m.memberId, role: m.role, online: m.online })),
          isPlaying: event.state.playback.isPlaying,
          positionMs: client.playheadMs(),
          role: event.state.members.find(m => m.memberId === this.status.memberId)?.role ?? this.status.role,
        })
      }
    })
    this.client = client
    this.session = new RoomSession({
      client,
      player: createPlayerAdapter(),
      onEvent: (event) => {
        if (event.type === 'track_changed' && event.remote) {
          this.update({ lastError: `房间切到：${event.track.name} - ${event.track.singer}（点开这首歌再继续听）` })
        }
      },
    })
    this.session.start()
    return client
  }

  /** 建房并成为控制端 */
  async createRoom(): Promise<JoinResult> {
    const client = this.ensureClient()
    const roomId = await client.createRoom()
    return this.join(roomId)
  }

  async join(roomId: string): Promise<JoinResult> {
    const client = this.ensureClient()
    const session = await client.joinRoom(roomId.trim())
    client.connect(session)
    this.update({ roomId: session.roomId, memberId: session.memberId, role: session.role, lastError: null })
    return session
  }

  async leave(): Promise<void> {
    const client = this.client
    const roomId = this.status.roomId
    this.session?.stop()
    this.session = null
    this.client = null
    if (client && roomId) await client.leave(roomId).catch(() => {})
    this.update({ connected: false, roomId: null, role: null, memberId: null, members: [], state: null })
  }

  /** 控制端：把本地操作同步到房间 */
  pushPlay(): void { this.session?.notifyPlay() }
  pushPause(): void { this.session?.notifyPause() }
  pushSeek(positionMs?: number): void { this.session?.notifySeek(positionMs) }
  pushTrack(): void { this.session?.notifyTrackChanged() }
  /** 成员端：申请 */
  requestPlay(): void { this.session?.requestPlay() }
  requestPause(): void { this.session?.requestPause() }
}

export const listenTogether = new ListenTogetherService()
