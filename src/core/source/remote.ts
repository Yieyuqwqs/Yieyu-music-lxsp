/**
 * 远端 LXSP Provider：一个 (endpoint, 音源) 就是一个 Provider。
 * 它只做「协议 ↔ 引擎内部类型」的翻译和字段校验，
 * 不做降档决策、不做换源 —— 那些统一在 resolver 里做一次。
 */
import { LxspTransport } from './transport'
import { LxspError } from './errors'
import { isDowngrade } from './quality'
import { declaredCapabilities, declaredQualities } from './manifest'
import { LXSP_PATHS } from './protocol'
import type {
  LyricResult,
  ProviderHealth,
  ProviderMeta,
  RequestContext,
  SearchQuery,
  SearchResultData,
  SourceProvider,
  TrackQuery,
  UrlQuery,
  UrlResult,
} from './types'

export interface RemoteProviderOptions {
  transport: LxspTransport
  manifest: LX.Lxsp.Manifest
  source: LX.Lxsp.SourceDecl
  /** 越小越优先；同一端点的多个音源共享同一 priority */
  priority: number
  /** 该端点专用超时（毫秒），缺省用协议默认值 */
  timeoutMs?: number
}

const isHttpUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//i.test(value)

const badResponse = (what: string, raw: unknown): never => {
  throw new LxspError('bad_response', `LXSP ${what} invalid`, { raw })
}

const requiredUrl = (value: unknown, what: string): string => {
  if (!isHttpUrl(value)) return badResponse(what, value)
  return value
}

const optionalString = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

export class RemoteProvider implements SourceProvider {
  readonly meta: ProviderMeta
  private readonly transport: LxspTransport
  private readonly endpoints: LX.Lxsp.Manifest['endpoints']
  private readonly timeoutMs?: number
  private readonly auth?: LX.Lxsp.Manifest['auth']

  constructor(options: RemoteProviderOptions) {
    this.transport = options.transport
    this.timeoutMs = options.timeoutMs
    this.auth = options.manifest.auth
    this.endpoints = options.manifest.endpoints
    this.meta = {
      id: `lxsp:${options.manifest.provider.id}:${options.transport.baseUrl}:${options.source.key}`,
      providerId: options.manifest.provider.id,
      name: options.manifest.provider.name,
      version: options.manifest.provider.version,
      kind: 'lxsp',
      endpoint: options.transport.baseUrl,
      source: options.source.key,
      priority: options.priority,
      qualities: declaredQualities(options.manifest, options.source.key),
      capabilities: declaredCapabilities(options.manifest, options.source.key),
    }
  }

  supports(capability: LX.Lxsp.Capability): boolean {
    return this.meta.capabilities.includes(capability)
  }

  private path(key: keyof typeof LXSP_PATHS): string {
    return this.endpoints?.[key] ?? LXSP_PATHS[key]
  }

  private call<T>(path: string, query: Record<string, string | number | boolean | null | undefined>, ctx: RequestContext = {}): Promise<T> {
    return this.transport.getJson<T>(path, query, {
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs ?? this.timeoutMs,
      trace: ctx.trace,
    })
  }

  async resolveUrl(query: UrlQuery, ctx: RequestContext = {}): Promise<UrlResult> {
    const path = `${this.path('url')}/${encodeURIComponent(query.source)}/${encodeURIComponent(query.id)}`
    const data = await this.call<LX.Lxsp.UrlData>(path, {
      quality: query.quality,
      name: query.name,
      singer: query.singer,
      album: query.album,
      duration: query.duration,
      fallback: query.fallback ? 1 : undefined,
    }, ctx)

    if (!data || typeof data !== 'object') return badResponse('url data', data)
    const url = requiredUrl(data.url, 'url data.url')
    const quality = optionalString(data.quality)
    if (!quality) return badResponse('url data.quality', data)

    const requested = query.quality ?? 'auto'
    return {
      url,
      quality: quality as LX.Lxsp.Quality,
      requestedQuality: (data.requestedQuality ?? requested) as LX.Lxsp.Quality | 'auto',
      // 服务端说了算，但客户端仍要独立复核，防止服务端漏报
      downgraded: data.downgraded === true || isDowngrade(requested, quality),
      expiresAt: data.expiresAt,
      streamUrl: isHttpUrl(data.streamUrl) ? data.streamUrl : undefined,
      detail: data.detail,
      via: data.via,
      extra: data.extra,
    }
  }

  async lyric(query: TrackQuery, ctx: RequestContext = {}): Promise<LyricResult> {
    const path = `${this.path('lyric')}/${encodeURIComponent(query.source)}/${encodeURIComponent(query.id)}`
    const data = await this.call<LX.Lxsp.LyricData>(path, {}, ctx)
    if (!data || typeof data !== 'object') return badResponse('lyric data', data)
    if (typeof data.lrc !== 'string' || !data.lrc.trim()) return badResponse('lyric data.lrc', data)
    return {
      lrc: data.lrc,
      tlrc: data.tlrc ?? null,
      rlrc: data.rlrc ?? null,
      lxlrc: data.lxlrc ?? null,
      format: data.format,
      offsetMs: data.offsetMs ?? null,
    }
  }

  async pic(query: TrackQuery, ctx: RequestContext = {}): Promise<string> {
    const path = `${this.path('pic')}/${encodeURIComponent(query.source)}/${encodeURIComponent(query.id)}`
    const data = await this.call<LX.Lxsp.PicData>(path, {}, ctx)
    if (!data || typeof data !== 'object') return badResponse('pic data', data)
    return requiredUrl(data.url, 'pic data.url')
  }

  async search(query: SearchQuery, ctx: RequestContext = {}): Promise<SearchResultData> {
    const data = await this.call<LX.Lxsp.SearchData>(this.path('search'), {
      q: query.text,
      page: query.page,
      limit: query.limit,
      sources: query.sources?.length ? query.sources.join(',') : undefined,
    }, ctx)
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return badResponse('search data', data)

    const items: LX.Lxsp.Track[] = []
    for (const item of data.items) {
      // 单条脏数据不该毁掉整页结果：丢弃并继续
      if (!item || typeof item !== 'object') continue
      const rawId = item.id as unknown
      const id = typeof rawId === 'number' && Number.isFinite(rawId) ? String(rawId) : (typeof rawId === 'string' ? rawId.trim() : '')
      if (!id) continue
      if (typeof item.name !== 'string' || !item.name.trim()) continue
      items.push({
        ...item,
        id,
        name: item.name.trim(),
        singer: typeof item.singer === 'string' ? item.singer : '',
      })
    }

    return {
      items,
      page: Number.isFinite(data.page) ? data.page : query.page,
      limit: Number.isFinite(data.limit) ? data.limit : query.limit,
      total: typeof data.total === 'number' ? data.total : null,
      hasMore: data.hasMore === true,
    }
  }

  async health(ctx: RequestContext = {}): Promise<ProviderHealth> {
    const startedAt = Date.now()
    const data = await this.call<LX.Lxsp.HealthData>(this.path('health'), {}, { ...ctx, timeoutMs: ctx.timeoutMs ?? 4_000 })
    const latencyMs = Date.now() - startedAt
    const status = data?.status === 'ok' || data?.status === 'degraded' || data?.status === 'down' ? data.status : 'ok'
    return { status, latencyMs }
  }
}
