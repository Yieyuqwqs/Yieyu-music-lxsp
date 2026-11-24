/**
 * 一起听 · 单例服务（App 侧唯一入口）
 *
 * 负责：读设置里的服务器地址 → 建房/加入 → 连 WS → 把状态交给 RoomSession 落到播放器。
 * 音频不经过任何房间服务：这里只同步「放什么、放到哪」。
 */
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { play, pause } from '@/core/player/player'
import { setCurrentTime, setResource, setPlay, setPlaybackRate } from '@/plugins/player/utils'
import { setPlayMusicInfo } from '@/core/player/playInfo'
import TrackPlayer from 'react-native-track-player'
import { ListenTogetherClient } from './client'
import { P2PRoom, makeRoomId } from './p2p-room'
import { getResolvedUrl, getLastResolvedUrl } from './resolved-url'
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
  /** 最近一条房间事件（切歌/对齐），方便排查「为什么没反应」 */
  lastEvent: string | null
  /** 共享队列（房间里的，不是本地列表） */
  queue: TrackRef[]
  currentIndex: number
}

const createPlayerAdapter = (): PlayerAdapter => ({
  play,
  pause: () => { void pause() },
  seek: (positionMs: number) => { void setCurrentTime(positionMs / 1000) },
  isPlaying: () => playerState.isPlay,
  positionMs: () => Math.max(0, playerState.progress.nowPlayTime * 1000),
  setRate: (rate: number) => { void setPlaybackRate(rate) },
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
  private clientBaseUrl = ''
  private session: RoomSession | null = null
  private status: RoomStatus = {
    connected: false, roomId: null, role: null, memberId: null,
    members: [], isPlaying: false, positionMs: 0, state: null, lastError: null, lastEvent: null,
    queue: [], currentIndex: -1,
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

  /** p2p: 前缀（或留空）表示免部署模式：用公共 MQTT broker，房主就是权威端 */
  private readonly P2P_PREFIX = 'p2p'
  private isP2PMode(): boolean {
    const raw = String(settingState.setting['common.listenTogetherServer'] ?? '').trim()
    return raw === '' || raw === this.P2P_PREFIX || raw.startsWith(this.P2P_PREFIX + ':') || raw.startsWith('mqtt')
  }

  private brokerUrl(): string | undefined {
    const raw = String(settingState.setting['common.listenTogetherServer'] ?? '').trim()
    const idx = raw.indexOf('wss://')
    if (idx >= 0) return raw.slice(idx)
    const wsIdx = raw.indexOf('ws://')
    if (wsIdx >= 0) return raw.slice(wsIdx)
    return undefined
  }

  private serverUrl(): string {
    const raw = String(settingState.setting['common.listenTogetherServer'] ?? '').trim()
    if (!raw) throw new Error('先在设置里填一起听服务器地址（免部署就填 p2p:）')
    return raw
  }

  private ensureClient(): ListenTogetherClient {
    const baseUrl = this.serverUrl()
    if (this.client && this.clientBaseUrl === baseUrl) return this.client
    if (this.client) {
      // 地址变了：断开旧连接，重建
      this.session?.stop()
      this.session = null
      this.client.disconnect()
      this.client = null
      this.update({ connected: false })
    }
    this.clientBaseUrl = baseUrl
    const client = new ListenTogetherClient({ baseUrl })
    client.on((event) => {
      if (event.type === 'open') this.update({ connected: true, lastError: null })
      else if (event.type === 'close') this.update({ connected: false })
      else if (event.type === 'error') this.update({ lastError: event.message })
      else if (event.type === 'rejected') this.update({ lastError: `请求被拒：${event.reason}` })
      else if (event.type === 'state') {
        this.update({
          state: event.state,
          queue: [...event.state.queue],
          currentIndex: event.state.currentIndex,
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

  /** 免部署模式：房主自己就是服务端 */
  private p2p: P2PRoom | null = null

  private startP2P(roomId: string, role: 'host' | 'guest'): void {
    this.p2p?.close()
    const room = new P2PRoom({
      roomId,
      role,
      brokerUrl: this.brokerUrl(),
      onConnected: () => this.update({ connected: true, lastError: null, roomId }),
      onDisconnected: () => this.update({ connected: false }),
      onState: (state, serverNow) => {
        this.update({
          state,
          roomId: state.roomId,
          role: state.members.find(m => m.memberId === room.memberId)?.role ?? (role === 'host' ? 'CONTROLLER' : 'LISTENER'),
          memberId: room.memberId,
          members: state.members.map(m => ({ memberId: m.memberId, role: m.role, online: m.online })),
          isPlaying: state.playback.isPlaying,
          positionMs: room.playheadMs(),
          queue: [...state.queue],
          currentIndex: state.currentIndex,
        })
        // 成员收到状态 → 对齐本地播放
        if (role === 'guest' && this.session) this.session.applyState(state)
      },
      onRejected: (requestType, reason) => this.update({ lastError: `请求被拒（${requestType}）：${reason}` }),
      onError: (message) => this.update({ lastError: message }),
    })
    this.p2p = room
    // 用适配器把 P2P 房间接进 RoomSession（成员侧靠它对齐播放器）
    const adapter = {
      on: () => () => {},
      get isController() { return role === 'host' },
      playheadMs: () => room.playheadMs(),
      play: () => room.control('PLAY'),
      pause: () => room.control('PAUSE'),
      seek: (positionMs: number) => room.control('SEEK', { positionMs }),
      setTrack: (track: { stableKey: string }) => room.control('SET_TRACK', { track }),
      setMode: (mode: string) => room.control('PLAYBACK_MODE', { mode }),
      notifyTrackFinished: () => room.control('TRACK_FINISHED', { trackStableKey: room.currentState.playback.trackStableKey }),
      requestPlay: () => room.request('REQUEST_PLAY'),
      requestPause: () => room.request('REQUEST_PAUSE'),
      requestSeek: (positionMs: number) => room.request('REQUEST_SEEK', { positionMs }),
    }
    this.session = new RoomSession({
      client: adapter as never,
      player: createPlayerAdapter(),
      onEvent: (event) => {
        if (event.type === 'track_changed' && event.remote) {
          void this.switchToTrack(event.track).then((ok) => {
            if (!ok) this.update({ lastError: `房间切到「${event.track.name}」，本机没找到这首歌` })
          })
        } else if (event.type === 'error') {
          this.update({ lastError: event.message })
        }
      },
    })
    room.start()
    this.update({ roomId, memberId: room.memberId, role: role === 'host' ? 'CONTROLLER' : 'LISTENER', connected: false })
    this.installPlayerHooks()
  }

  /** 建房并成为控制端 */
  async createRoom(): Promise<JoinResult> {
    if (this.isP2PMode()) {
      const roomId = makeRoomId()
      this.startP2P(roomId, 'host')
      return { roomId, memberId: this.p2p!.memberId, role: 'CONTROLLER', memberSecret: '', wsUrl: 'p2p:' }
    }
    return this.createRoomHttp()
  }

  private async createRoomHttp(): Promise<JoinResult> {
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
    if (this.isP2PMode()) {
      const clean = roomId.trim().toLowerCase()
      if (!/^[0-9a-z]{4,32}$/.test(clean)) {
        const error = new Error('房号不合法（免部署房号是 4-32 位小写字母数字）')
        this.update({ lastError: error.message })
        throw error
      }
      this.startP2P(clean, 'guest')
      return { roomId: clean, memberId: this.p2p!.memberId, role: 'LISTENER', memberSecret: '', wsUrl: 'p2p:' }
    }
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
    if (this.p2p) {
      this.p2p.close()
      this.p2p = null
      this.session?.stop()
      this.session = null
      setPlayerHooks({})
      this.hooksInstalled = false
      this.update({ connected: false, roomId: null, role: null, memberId: null, members: [], state: null })
      return
    }
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
        // 控制端换曲：等播放器把直链装好再同步（ensure 直链能带过去）
        if (!this.client?.isController && !this.p2p) return
        setTimeout(() => { void this.pushTrackWithUrl() }, 600)
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
      this.update({ lastEvent: `收到切歌：${track.name} - ${track.singer}（${track.stableKey}）` })
      // 最优：房主已经把直链解析好了，直接放它（不依赖搜索、不依赖两端 id 一致）
      if (track.url && /^https?:\/\//i.test(track.url)) {
        const info = toNewMusicInfo({
          source: track.source,
          name: track.name,
          singer: track.singer,
          songmid: track.id,
          interval: '',
          albumName: '',
          img: '',
        })
        setPlayMusicInfo(null, info, true)
        const seekSeconds = Math.max(0, (this.p2p?.playheadMs() ?? 0) / 1000)
        setResource(info as never, track.url, seekSeconds)
        void setPlay()
        this.update({ lastError: null, lastEvent: `用房间直链播放：${track.name}` })
        return true
      }

      // 次优：房间给的 source:id 就是平台歌曲 ID，还原成在线曲目交给播放器
      if (track.source && track.id && track.source !== 'local') {
        const info = toNewMusicInfo({
          source: track.source,
          name: track.name,
          singer: track.singer,
          songmid: track.id,
          interval: '',
          albumName: '',
          img: '',
        })
        setMusicUrl(info as never)
        this.update({ lastError: null, lastEvent: `已切到：${track.name} - ${track.singer}` })
        return true
      }
      const listId = playerState.playMusicInfo.listId
      const list = listId ? (getList(listId) as Array<{ id?: string, source?: string, name?: string, singer?: string, meta?: { songId?: string } }>) : []
      const hit = list.find(item => stableKeyOfMusicInfo(item) === track.stableKey) ??
        pickBestTrack(list, track)
      if (hit && listId) {
        await playListById(listId, String(hit.id))
        this.update({ lastError: null, lastEvent: `已在当前列表切到：${track.name}` })
        return true
      }

      const items = await this.searchLocal(track)
      const best = pickBestTrack(items, track)
      if (!best) {
        this.update({ lastError: `本机找不到「${track.name}」`, lastEvent: null })
        return false
      }
      setMusicUrl(toNewMusicInfo(best) as never)
      this.update({ lastError: null, lastEvent: `搜索命中并切歌：${track.name}` })
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

  /** 控制端：把当前歌曲（带直链）同步到房间 —— 这条是「换歌能不能过去」的关键 */
  async pushTrackWithUrl(): Promise<void> {
    const base = createPlayerAdapter().currentTrack()
    if (!base) {
      this.update({ lastError: '当前没有在播的歌，无法同步' })
      return
    }
    // 先看解析登记表（最可靠），再退回播放器内部状态
    let url: string | undefined = getResolvedUrl(base.source, base.id) ?? getLastResolvedUrl() ?? undefined
    if (!url) {
      try {
        const active = await TrackPlayer.getActiveTrack() as { url?: string } | undefined
        url = active?.url
      } catch (error) { /* 取不到就不带直链，退回按 id 还原 */ }
    }
    const track = url ? { ...base, url } : base
    if (this.p2p) this.p2p.control('SET_TRACK', { track })
    else this.session?.notifyTrackChanged(track)
    this.update({ lastEvent: url ? `已同步：${track.name}（含直链）` : `已同步：${track.name}（无直链）` })
  }

  /** 控制端：把本地操作同步到房间 */
  pushPlay(): void {
    if (this.p2p) {
      const currentKey = this.p2p.currentState.playback.trackStableKey
      const track = createPlayerAdapter().currentTrack()
      if (track && track.stableKey !== currentKey) {
        void this.pushTrackWithUrl()
      }
      this.p2p.control('PLAY')
      return
    }
    this.session?.notifyPlay()
  }
  pushPause(): void {
    if (this.p2p) { this.p2p.control('PAUSE'); return }
    this.session?.notifyPause()
  }
  pushSeek(positionMs?: number): void {
    if (this.p2p) {
      const track = createPlayerAdapter().currentTrack()
      if (track && track.stableKey !== this.p2p.currentState.playback.trackStableKey) {
        this.p2p.control('SET_TRACK', { track })
      }
      this.p2p.control('SEEK', { positionMs: positionMs ?? playerState.progress.nowPlayTime * 1000 })
      return
    }
    this.session?.notifySeek(positionMs)
  }
  pushTrack(): void {
    void this.pushTrackWithUrl()
  }
  /** 把当前正在播的歌加进共享队列（谁都能加） */
  addCurrentToQueue(): void {
    const track = createPlayerAdapter().currentTrack()
    if (!track) {
      this.update({ lastError: '当前没有在播的歌' })
      return
    }
    if (this.p2p) this.p2p.queueAdd([track])
    else void this.pushQueueAdd([track])
    this.update({ lastEvent: `已加入队列：${track.name}` })
  }

  /** 把某首歌加进共享队列 */
  addTrackToQueue(track: TrackRef): void {
    if (this.p2p) this.p2p.queueAdd([track])
    else void this.pushQueueAdd([track])
    this.update({ lastEvent: `已加入队列：${track.name}` })
  }

  /** 从共享队列里删掉 */
  removeFromQueue(stableKey: string): void {
    if (this.p2p) this.p2p.queueRemove(stableKey)
    else void this.pushQueueRemove(stableKey)
  }

  /** 点队列里的第 index 首 → 切过去（房主直接切，成员走申请） */
  playQueueIndex(index: number): void {
    const track = this.status.queue[index]
    if (!track) return
    if (this.p2p) {
      if (this.p2p.role === 'host') this.p2p.control('SET_TRACK', { track, index })
      else this.p2p.request('REQUEST_SET_TRACK', { track })
      return
    }
    this.session?.notifyTrackChanged(track, index)
  }

  private async pushQueueAdd(tracks: TrackRef[]): Promise<void> {
    const client = this.client
    if (!client) return
    await client.setQueue([...this.status.queue, ...tracks], this.status.currentIndex).catch(() => {})
  }

  private async pushQueueRemove(stableKey: string): Promise<void> {
    const client = this.client
    if (!client) return
    const queue = this.status.queue.filter(track => track.stableKey !== stableKey)
    await client.setQueue(queue, this.status.currentIndex).catch(() => {})
  }

  /** 成员端：申请 */
  requestPlay(): void {
    if (this.p2p) { this.p2p.request('REQUEST_PLAY'); return }
    this.session?.requestPlay()
  }
  requestPause(): void {
    if (this.p2p) { this.p2p.request('REQUEST_PAUSE'); return }
    this.session?.requestPause()
  }
}

export const listenTogether = new ListenTogetherService()
