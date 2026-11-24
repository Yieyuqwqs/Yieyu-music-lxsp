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
import { setPlayerHooks } from '@/core/player/hooks'
import { getList } from '@/core/player/playInfo'
import { playListById, setMusicUrl } from '@/core/player/player'
import { sourceEngine } from '@/core/source'
import musicSdk from '@/utils/musicSdk'
import { toNewMusicInfo } from '@/utils'
import { pickBestTrack, stableKeyOfMusicInfo } from './track-map'
import type { TrackRef } from './protocol'
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
          // 名单外的成员跟着房主换曲：先在本机找，找不到再提示
          void this.switchToTrack(event.track).then((ok) => {
            if (!ok) this.update({ lastError: `房间切到「${event.track.name}」，本机没找到这首歌` })
          })
        }
      },
    })
    this.session.start()
    return client
  }

  /** 建房并成为控制端 */
  async createRoom(): Promise<JoinResult> {
    try {
      const client = this.ensureClient()
      const roomId = await client.createRoom()
      return await this.join(roomId)
    } catch (error) {
      this.update({ lastError: `建房失败：${(error as Error).message}` })
      throw error
    }
  }

  async join(roomId: string): Promise<JoinResult> {
    try {
      return await this.joinInner(roomId)
    } catch (error) {
      this.update({ lastError: `加入失败：${(error as Error).message}` })
      throw error
    }
  }

  private async joinInner(roomId: string): Promise<JoinResult> {
    const client = this.ensureClient()
    const session = await client.joinRoom(roomId.trim())
    this.installPlayerHooks()
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
    setPlayerHooks({})
    this.hooksInstalled = false
    this.update({ connected: false, roomId: null, role: null, memberId: null, members: [], state: null })
  }

  /**
   * 自动上报：把播放器的真实动作同步给房间（控制端才生效）。
   * 钩子在服务生命周期里只注册一次，离开房间时清掉。
   */
  private hooksInstalled = false
  private installPlayerHooks(): void {
    if (this.hooksInstalled) return
    this.hooksInstalled = true
    setPlayerHooks({
      onPlay: () => this.pushPlay(),
      onPause: () => this.pushPause(),
      onSeek: (positionMs) => this.pushSeek(positionMs),
      onTrackChange: (musicInfo) => {
        // 控制端换曲：直接把这一首同步上去（用回调里的 musicInfo，而不是再去读可能还没更新的 playerState）
        if (!this.client?.isController) return
        const track = musicInfo ? this.toRef(musicInfo as never) : null
        if (track) this.session?.notifyTrackChanged(track)
      },
    })
  }

  private toRef(musicInfo: { id?: string, source?: string, name?: string, singer?: string, interval?: string, meta?: { songId?: string } }): TrackRef | null {
    if (!musicInfo?.source || !musicInfo.name) return null
    return ListenTogetherClient.toTrackRef({
      id: musicInfo.meta?.songId ?? musicInfo.id,
      source: musicInfo.source,
      name: musicInfo.name,
      singer: musicInfo.singer,
      interval: musicInfo.interval,
    })
  }

  /**
   * 房间切歌 → 本机自动切。
   * 顺序：当前列表里找 → 端点/内置搜索同名 → 都没有就只提示。
   */
  async switchToTrack(track: TrackRef): Promise<boolean> {
    try {
      const listId = playerState.playMusicInfo.listId
      const list = listId ? (getList(listId) as Array<{ id?: string, source?: string, name?: string, singer?: string, meta?: { songId?: string } }>) : []
      const hit = list.find(item => stableKeyOfMusicInfo(item) === track.stableKey) ??
        pickBestTrack(list, track)
      if (hit && listId) {
        await playListById(listId, String(hit.id))
        this.update({ lastError: null })
        return true
      }

      const items = await this.searchLocal(track)
      const best = pickBestTrack(items, track)
      if (!best) {
        this.update({ lastError: `本机找不到「${track.name}」` })
        return false
      }
      setMusicUrl(toNewMusicInfo(best) as never)
      this.update({ lastError: null })
      return true
    } catch (error) {
      this.update({ lastError: `自动切歌失败：${(error as Error).message}` })
      return false
    }
  }

  private async searchLocal(track: TrackRef): Promise<Array<{ id?: string, source?: string, name?: string, singer?: string, meta?: { songId?: string } }>> {
    const keyword = `${track.name} ${track.singer}`.trim()
    if (sourceEngine.isInited && sourceEngine.hasSearchProvider(track.source as never)) {
      const result = await sourceEngine.search(track.source as never, keyword, 1, 10)
      return (result.list ?? []) as never
    }
    const sdk = (musicSdk as unknown as Record<string, { musicSearch?: { search: (text: string, page: number, limit: number) => Promise<{ list?: unknown[] }> } }>)[track.source]
    if (sdk?.musicSearch) {
      const result = await sdk.musicSearch.search(keyword, 1, 10)
      return (result.list ?? []) as never
    }
    return []
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
