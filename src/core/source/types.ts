/** 最小可移植的信号抽象：不依赖 DOM lib 类型，RN/node 都能过 */
export interface AbortSignalLike {
  readonly aborted: boolean
  addEventListener?: (type: 'abort', listener: () => void) => void
  removeEventListener?: (type: 'abort', listener: () => void) => void
}
/**
 * 引擎内部类型：Provider 抽象。
 * 内置源（legacy）与远端 LXSP 源实现同一个接口 —— 这是「统一音源架构」的落点：
 * 上层只认 Provider，不认「这是脚本还是内置模块」。
 */

export type ProviderKind = 'lxsp' | 'legacy'

export interface ProviderMeta {
  /** Provider 实例唯一 id（同一提供方的镜像要带 endpoint 区分） */
  id: string
  /** 提供方 id（manifest.provider.id；legacy 为 'builtin'） */
  providerId: string
  name: string
  version: string
  kind: ProviderKind
  /** 远端才有 */
  endpoint?: string
  /** 该 Provider 负责的 LX 音源 */
  source: LX.Source
  /** 越小越优先 */
  priority: number
  qualities: LX.Lxsp.Quality[]
  capabilities: LX.Lxsp.Capability[]
}

export interface RequestContext {
  signal?: AbortSignalLike
  timeoutMs?: number
  trace?: string
}

export interface TrackQuery {
  source: LX.Source
  id: string
  name?: string
  singer?: string
  album?: string
  /** 毫秒 */
  duration?: number
}

export interface UrlQuery extends TrackQuery {
  quality?: LX.Lxsp.Quality
  /** 允许跨平台兜底 */
  fallback?: boolean
  extra?: Record<string, string>
}

export interface UrlResult {
  url: string
  quality: LX.Lxsp.Quality
  requestedQuality: LX.Lxsp.Quality | 'auto'
  downgraded: boolean
  expiresAt?: string | number
  streamUrl?: string
  detail?: LX.Lxsp.QualityDetail
  via?: LX.Lxsp.UrlData['via']
  extra?: Record<string, string>
}

export interface LyricResult {
  lrc: string
  tlrc?: string | null
  rlrc?: string | null
  lxlrc?: string | null
  format?: string
  offsetMs?: number | null
}

export interface SearchQuery {
  text: string
  page: number
  limit: number
  /** 多音源聚合时使用 */
  sources?: LX.Source[]
}

export interface SearchResultData {
  items: LX.Lxsp.Track[]
  page: number
  limit: number
  total?: number | null
  hasMore: boolean
}

export interface ProviderHealth {
  status: 'ok' | 'degraded' | 'down'
  latencyMs?: number
}

export interface SourceProvider {
  readonly meta: ProviderMeta
  supports: (capability: LX.Lxsp.Capability) => boolean
  resolveUrl: (query: UrlQuery, ctx: RequestContext) => Promise<UrlResult>
  lyric: (query: TrackQuery, ctx: RequestContext) => Promise<LyricResult>
  pic: (query: TrackQuery, ctx: RequestContext) => Promise<string>
  search: (query: SearchQuery, ctx: RequestContext) => Promise<SearchResultData>
  health?: (ctx: RequestContext) => Promise<ProviderHealth>
}

/** 一次解析尝试的记录，用于 UI 展示「为什么换源」与日志排障 */
export interface ResolveAttempt {
  providerId: string
  source: LX.Source
  quality?: LX.Lxsp.Quality
  ok: boolean
  code?: LX.Lxsp.ErrorCode
  message?: string
  elapsedMs: number
}

export interface ResolveResult<T> {
  value: T
  provider: ProviderMeta
  attempts: ResolveAttempt[]
}

export interface ResolveUrlResult extends ResolveResult<UrlResult> {
  /** 实际使用的音源（跨平台兜底后可能与请求不同） */
  source: LX.Source
}

export interface ResolverHooks {
  /** 按 (name, singer) 记住成功音源 */
  rememberSource?: (info: { source: LX.Source, name: string, singer: string }) => void
  /** 该音源被判定为坏源（超时/限流等），引擎可临时降权 */
  markUnhealthy?: (providerId: string, code: LX.Lxsp.ErrorCode) => void
  /** 解析进度回调（UI/日志） */
  onAttempt?: (attempt: ResolveAttempt) => void
}
