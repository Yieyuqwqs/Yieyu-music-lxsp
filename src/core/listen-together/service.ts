/**
 * 一起听 · 单例服务（App 侧唯一入口）
 *
 * 负责：读设置里的服务器地址 → 建房/加入 → 连 WS → 把状态交给 RoomSession 落到播放器。
 * 音频不经过任何房间服务：这里只同步「放什么、放到哪」。
 */
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { play, pause } from '@/core/player/player'
import { setCurrentTime, setPlaybackRate } from '@/plugins/player/utils'
import { setPlayMusicInfo } from '@/core/player/playInfo'
import TrackPlayer from 'react-native-track-player'
import { ListenTogetherClient } from './client'
import { P2PRoom, makeRoomId } from './p2p-room'
import { monotonicMs, primeClock } from '@/utils/nativeModules/clockrt'
import { isDirectAvailable } from '@/utils/nativeModules/p2p'
import { cancelNative, pushAnchor, scheduleNative, startSyncPump, syncClear, syncPlayheadMs, isSyncEngineAvailable } from '@/utils/nativeModules/syncEngine'
import { playheadAt } from './playhead'
import { getResolvedUrl, getLastResolvedUrl, rememberResolvedUrl } from './resolved-url'
import { getMusicUrl } from '@/core/music'
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
import { reportError } from '@/core/listen-together/errors'
import { logMediaProbe } from '@/core/listen-together/telemetry'

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
  /** 房间当前歌曲的实时状态（UI 每秒取一次 playheadMs 显示） */
  nowPlaying: { name: string, singer: string, stableKey: string, isPlaying: boolean } | null
  /** 原生引擎能力（C++ 直连 / C++ 同步引擎是否真的装进了这个 APK） */
  engine: { direct: boolean, sync: boolean, nativeClock: boolean }
  /** 当前通道（唯一真相来源，由 P2PRoom 上报）：connecting / direct / relay */
  transport: 'connecting' | 'direct' | 'relay'
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
    queue: [], currentIndex: -1, nowPlaying: null,
    transport: 'connecting',
    engine: { direct: false, sync: false, nativeClock: false },
  }
  private listeners = new Set<(status: RoomStatus) => void>()

  /** 探测原生能力（App 启动时调一次即可） */
  probeEngine(): void {
    const direct = isDirectAvailable()
    const sync = isSyncEngineAvailable()
    this.update({ engine: { direct, sync, nativeClock: direct || sync } })
  }

  getStatus(): RoomStatus {
    // 每次取状态都实时探测原生能力（布尔判断，零成本），不再依赖“有没有人记得调 probeEngine”
    const directNow = isDirectAvailable()
    const syncNow = isSyncEngineAvailable()
    return {
      ...this.status,
      members: [...this.status.members],
      engine: { direct: directNow, sync: syncNow, nativeClock: directNow || syncNow },
    }
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
      try { listener(snapshot) } catch (error) { reportError('listener', error) }
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
          nowPlaying: (() => {
            const current = event.state.queue[event.state.currentIndex]
            return current ? { name: current.name, singer: current.singer, stableKey: current.stableKey, isPlaying: event.state.playback.isPlaying } : null
          })(),
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

  /** 原子地重置所有会话资源（切房/切模式/离开都走它，避免旧实例继续广播） */
  /** 会话代际：每次建/切/离开都 +1；过期回调一律 no-op（结构性防串场） */
  private generation = 0

  /**
   * 同步 teardown：必须在建新会话【之前】同步跑完。
   * 之前这里是 async 且被 void 调用，内部 await 之后又把刚装好的播放器钩子清空了——
   * 表现就是“房主本地播放动作不广播”。根因是顺序，不是钩子本身。
   */
  private teardownSync(): void {
    this.p2p?.close()
    this.p2p = null
    if (this.stopSyncPump) { this.stopSyncPump(); this.stopSyncPump = null }
    this.scheduled.clear()
    this.session?.stop()
    this.session = null
    this.client?.disconnect()
    this.client = null
    this.clientBaseUrl = ''
    setPlayerHooks({})
    this.hooksInstalled = false
  }

  /** 异步清理（预缓冲轨），带代际校验，绝不回写新会话的状态 */
  private cleanupAsync(generation: number): void {
    void this.clearPreloads().catch(() => {})
    if (generation !== this.generation) return
  }

  private startP2P(roomId: string, role: 'host' | 'guest'): void {
    this.generation += 1
    this.teardownSync()
    const room = new P2PRoom({
      roomId,
      role,
      brokerUrl: this.brokerUrl(),
      altBrokerUrl: 'wss://broker-cn.emqx.io:8084/mqtt',
      onConnected: () => this.update({ connected: true, lastError: null, roomId }),
      onDisconnected: () => this.update({ connected: false }),
      onState: (state, serverNow) => {
        void primeClock()
        void pushAnchor(state.playback, serverNow)
        this.update({
          state,
          roomId: this.status.roomId ?? roomId,
          role: state.members.find(m => m.memberId === room.memberId)?.role ?? (role === 'host' ? 'CONTROLLER' : 'LISTENER'),
          memberId: room.memberId,
          members: state.members.map(m => ({ memberId: m.memberId, role: m.role, online: m.online })),
          isPlaying: state.playback.isPlaying,
          positionMs: room.playheadMs(),
          queue: [...state.queue],
          currentIndex: state.currentIndex,
        })
        const current = state.queue[state.currentIndex]
        this.update({
          nowPlaying: current
            ? { name: current.name, singer: current.singer, stableKey: current.stableKey, isPlaying: state.playback.isPlaying }
            : null,
        })
        this.ensureQueueUrls()
        // 角色差异用查表派发，不写条件分支
        const roleHandlers = {
          host: () => {},
          guest: () => {
            void this.preloadNextTrack(state.queue[state.currentIndex + 1])
            // 唯一一条对齐路径：RoomSession.applyState（内部 version 守卫）
            this.session?.applyState(state)
          },
        }
        roleHandlers[role]()

      },
      onTransportChange: (info) => this.update({ transport: info.transport }),
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
    this.session.start()
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
    this.generation += 1
    await this.clearPreloads()
    if (this.stopSyncPump) { this.stopSyncPump(); this.stopSyncPump = null }
    this.scheduled.clear()
    await syncClear()
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
    const generation = this.generation
    const alive = () => generation === this.generation
    setPlayerHooks({
      onPlay: () => { if (alive()) this.pushPlay() },
      onPause: () => { if (alive()) this.pushPause() },
      onSeek: (positionMs) => { if (alive()) this.pushSeek(positionMs) },
      onTrackChange: (musicInfo) => {
        // 只有房主才往房间推；成员端的换歌是「被动的」，推回去会打架
        if (!alive() || !this.isHost()) return
        // 直链可能还没好，先占位推一次（不带链接），等 onResourceReady 再补带链接的一次
        setTimeout(() => { if (this.isHost()) void this.pushTrackWithUrl() }, 250)
      },
      onResourceReady: () => {
        // 直链已经落地：立刻把「歌 + 直链」推给房间，这才是丝滑的关键一步
        if (!alive() || !this.isHost()) return
        void this.pushTrackWithUrl()
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
    await this.clearPreloads()
    try {
      this.update({ lastEvent: `收到切歌：${track.name} - ${track.singer}（${track.stableKey}）` })
      // 结构：房间直链只作为「缓存提示」，播放一律走 App 自己的 setMusicUrl 管线。
      // 根因：之前手工 setPlayMusicInfo + setResource + setPlay 绕过了 App 的解析/校验/UA/降级链路，
      //   一旦这条直链在对方网络不可取（防盗链/签名过期），ExoPlayer 加载失败，
      //   表现就是主界面 00:00/00:00 无法播放，而房间状态已经推进（图一 00:25、图二 00:00）。
      if (track.url && /^https?:\/\//i.test(track.url)) {
        const media = await this.probeMediaUrl(track.url)
        if (!media.ok) {
          this.update({ lastEvent: `房间直链不可用（http=${media.status} 字节=${media.bytes}），改用本机解析：${track.name}` })
        } else {
        const info = toNewMusicInfo({
          source: track.source,
          name: track.name,
          singer: track.singer,
          songmid: track.id,
          interval: '',
          albumName: '',
          img: '',
          types: this.placeholderTypes(),
          _types: this.placeholderTypes(),
        })
          rememberResolvedUrl(info as never, track.url)
          setPlayMusicInfo(null, info, true)
          setMusicUrl(info as never)
          this.update({ lastError: null, lastEvent: `按房间直链播放：${track.name}（已验证 ${media.status}/${media.bytes}B）` })
          return true
        }
      }

      // 次优：房间给的 source:id 就是平台歌曲 ID，还原成在线曲目交给播放器
      if (track.source && track.id && track.source !== 'local') {
        try {
          const info = toNewMusicInfo({
            source: track.source,
            name: track.name,
            singer: track.singer,
            songmid: track.id,
            interval: '',
            albumName: '',
            img: '',
            types: this.placeholderTypes(),
            _types: this.placeholderTypes(),
          })
          setMusicUrl(info as never)
          this.update({ lastError: null, lastEvent: `已切到：${track.name} - ${track.singer}` })
          return true
        } catch (error) {
          // 这种还原方式不被音源接受：继续往下走「本地列表 / 搜索」两条路
          this.update({ lastEvent: `直连还原失败，改用本地查找：${track.name}` })
        }
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
  /** 房间播放头（毫秒）：p2p/http 各自算，UI 每秒取一次 */

  /**
   * 播放前先验证房间直链可用（结构：不可用的链接绝不交给播放器）。
   *
   * 根因：之前把房间直链直接塞给播放器，链接在对方网络被 CDN 拒绝时，
   * ExoPlayer 加载失败 → 主界面 00:00/00:00 且不报错。
   */
  private async probeMediaUrl(url: string): Promise<{ ok: boolean, status: number, bytes: number, type: string }> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 2500) : null
    try {
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
        signal: controller?.signal,
      })
      const buffer = await response.arrayBuffer()
      const type = response.headers.get('content-type') ?? ''
      const ok = (response.status === 200 || response.status === 206) &&
        buffer.byteLength > 512 && !/text\/html/i.test(type)
      logMediaProbe(url, { ok, status: response.status, bytes: buffer.byteLength, type })
      return { ok, status: response.status, bytes: buffer.byteLength, type }
    } catch (error) {
      reportError('media-probe', error)
      return { ok: false, status: 0, bytes: 0, type: '' }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 把当前正在播的歌加进共享队列（谁都能加） */
  /** 我是房主吗（p2p 看角色，http 看客户端身份） */
  private isHost(): boolean {
    if (this.p2p) return this.p2p.role === 'host'
    return this.client?.isController ?? false
  }

  private startTimer: ReturnType<typeof setTimeout> | null = null
  /** 原生定时命令表：id → 要执行的回调 */
  private scheduled = new Map<number, () => void>()
  private nextCommandId = 1
  private stopSyncPump: (() => void) | null = null

  /**
   * 成员端「按锚点起播」：房主的 SET_TRACK 带 400ms 提前量，
   * 收到后不立刻播，而是等到锚点生效的那一刻再 seek+play ——
   * 这样两端的第一个音符是同一秒出声，而不是“你先响 1 秒我才加载完”。
   */
  /** 原生定时调度：优先走 C++ 线程，失败才用 JS 定时器 */
  private async scheduleAt(delayMs: number, run: () => void): Promise<void> {
    const id = this.nextCommandId++
    this.scheduled.set(id, run)
    if (!this.stopSyncPump) {
      this.stopSyncPump = startSyncPump((commandId) => {
        const task = this.scheduled.get(commandId)
        if (!task) return
        this.scheduled.delete(commandId)
        try { task() } catch (error) { /* 命令执行失败不影响房间 */ }
      })
    }
    const ok = await scheduleNative(id, delayMs)
    if (!ok) {
      setTimeout(() => {
        const task = this.scheduled.get(id)
        if (!task) return
        this.scheduled.delete(id)
        try { task() } catch (error) { /* 忽略 */ }
      }, Math.max(0, Math.round(delayMs)))
    }
  }





  /** 房间播放头（毫秒）：p2p 用房间时钟、http 用客户端时钟，UI 每秒取一次 */
  playheadMs(): number {
    // 优先进原生（单调时钟、无桥抖动），不可用时再走 JS
    return syncPlayheadMs(() => this.playheadFallback())
  }

  private playheadFallback(): number {
    try {
      if (this.p2p) return this.p2p.playheadMs()
      if (this.client) return this.client.playheadMs()
    } catch (error) { /* 出错就退回快照值，绝不让 UI 崩 */ }
    return this.status.positionMs
  }

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

  /** 后台把队列里缺直链的歌解析出来（谁能解析谁解析，解析成功就分享给房间） */
  private resolving = new Set<string>()
  /** 已经预热过的直链（避免重复占用流量） */
  private warmed = new Set<string>()
  /** 解析失败的曲目 → 下次允许重试的时间（退避 60 秒，避免每 3 秒一次的无用请求） */
  private resolveFailedAt = new Map<string, number>()
  /** 预缓冲轨的 id 前缀（绝不与 App 自己的 track id 冲突） */
  private readonly PRELOAD_TRACK_PREFIX = 'lxp2p_preload_'
  /** 预加载窗口：当前曲目后面几首要提前解析好直链 */
  private readonly PRELOAD_AHEAD = 2
  private ensureQueueUrls(): void {
    const room = this.p2p
    if (!room) return
    // 只预热「当前 + 后两首」，别把 200 首全解析了
    const from = Math.max(0, this.status.currentIndex)
    const window_ = this.status.queue.slice(from, from + this.PRELOAD_AHEAD + 1)
    for (const track of window_) {
      if (track.url) continue
      if (this.resolving.has(track.stableKey)) continue
      const failedAt = this.resolveFailedAt.get(track.stableKey)
      if (failedAt && Date.now() - failedAt < 60_000) continue
      if (!track.source || !track.id || track.source === 'local') continue
      this.resolving.add(track.stableKey)
      void (async() => {
        try {
          const info = toNewMusicInfo({
            source: track.source, name: track.name, singer: track.singer,
            songmid: track.id, interval: '', albumName: '', img: '',
          })
          const url = await getMusicUrl({ musicInfo: info as never })
          if (url && /^https?:\/\//i.test(url)) {
            this.resolveFailedAt.delete(track.stableKey)
            rememberResolvedUrl(info as never, url)
            room.shareUrl(track.stableKey, url)
            void this.warmUpUrl(url)
            this.update({ lastEvent: `队列已备好直链：${track.name}` })
          }
        } catch (error) {
          // 记一次失败时间，60 秒内不再重试（播放时仍会尝试）
          this.resolveFailedAt.set(track.stableKey, Date.now())
        } finally {
          this.resolving.delete(track.stableKey)
        }
      })()
    }
  }

  /**
   * 预热直链：只拉前 32KB。
   * 目的不是缓存整首歌，而是把 DNS 解析、TLS 握手、CDN 边缘回源这几百毫秒提前做掉 ——
   * 真正切歌时播放器只要接着往下读，起播就快。
   */
  private async warmUpUrl(url: string): Promise<void> {
    if (!url || this.warmed.has(url)) return
    this.warmed.add(url)
    try {
      await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-32767' } })
    } catch (error) { /* 预热失败不影响播放 */ }
  }

  /** 把下一首塞进播放器队列做预缓冲（只对成员端有意义：房主那边是它自己在放） */
  private async preloadNextTrack(track: TrackRef | undefined | null): Promise<void> {
    if (!track?.url || !/^https?:/i.test(track.url)) return
    if (settingState.setting['common.listenTogetherPrebuffer'] === false) return
    try {
      const queue = await TrackPlayer.getQueue() as Array<{ id?: string }>
      const id = this.PRELOAD_TRACK_PREFIX + track.stableKey
      if (queue.some(item => item?.id === id)) return
      await TrackPlayer.add({
        id,
        url: track.url,
        title: track.name,
        artist: track.singer,
        isLiveStream: false,
      } as never)
      this.update({ lastEvent: `已预缓冲下一首：${track.name}` })
    } catch (error) { /* 预缓冲失败不影响播放 */ }
  }

  /** 清掉所有预缓冲轨（切歌前 / 离开房间时） */
  private async clearPreloads(): Promise<void> {
    try {
      const queue = await TrackPlayer.getQueue() as Array<{ id?: string }>
      for (let i = queue.length - 1; i >= 0; i--) {
        const id = queue[i]?.id ?? ''
        if (id.startsWith(this.PRELOAD_TRACK_PREFIX)) await TrackPlayer.remove(i)
      }
    } catch (error) { /* 忽略 */ }
  }

  /** 占位音质表：还原曲目时必须有，否则音源层读 qualitys.xxx 会抛异常 */
  private placeholderTypes(): Record<string, { size: string, hash: string | null }> {
    const keys = ['128k', '320k', 'flac', 'flac24bit', 'flac32bit', 'wav', 'ape', 'master', 'atmos']
    const out: Record<string, { size: string, hash: string | null }> = {}
    for (const key of keys) out[key] = { size: '', hash: null }
    return out
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
      if (this.p2p.role === 'host') {
        // 关键：房主也要真的切本地播放，否则房间状态变了但自己没声音
        void this.switchToTrack(track).finally(() => {
          this.p2p?.control('SET_TRACK', { track, index })
        })
      } else {
        this.p2p.request('REQUEST_SET_TRACK', { track })
      }
      return
    }
    void this.switchToTrack(track).finally(() => { this.session?.notifyTrackChanged(track, index) })
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
