/**
 * 解析流水线：整个音源架构唯一的「决策点」。
 *
 * 决策内容（以前散落在 5 个内置模块 + 每个 JS 脚本里）：
 *   1. 用哪个 Provider（健康度 → 优先级）
 *   2. 用哪个音质（规范阶梯降档）
 *   3. 什么错误该降档、什么错误该换源、什么错误该直接放弃
 *   4. 并发相同的请求如何合并
 *
 * 这里不区分「内置源」和「远端源」，也不需要知道协议细节。
 */
import { isDowngrade, pickCandidates } from './quality'
import { Singleflight, TtlCache } from './cache'
import { LxspError, toLxspError } from './errors'
import { DEFAULT_LIMITS } from './protocol'
import { noProviderError } from './registry'
import type { SourceRegistry } from './registry'
import type {
  LyricResult,
  ResolveAttempt,
  ResolveResult,
  ResolveUrlResult,
  ResolverHooks,
  SearchResultData,
  SourceProvider,
  TrackQuery,
  UrlQuery,
  UrlResult,
} from './types'

export interface ResolverOptions {
  registry: SourceRegistry
  hooks?: ResolverHooks
  /** 直链结果缓存时长；默认 0（不缓存，避免过期直链） */
  urlCacheTtlMs?: number
  lyricCacheTtlMs?: number
  picCacheTtlMs?: number
  maxAttempts?: number
  now?: () => number
}

export interface ResolveUrlInput extends TrackQuery {
  quality?: LX.Lxsp.Quality
  /** 允许服务端跨平台兜底 */
  fallback?: boolean
}

export class SourceResolver {
  private readonly registry: SourceRegistry
  private readonly hooks: ResolverHooks
  private readonly maxAttempts: number
  private readonly urlCacheTtlMs: number
  private readonly urlCache: TtlCache<string, UrlResult>
  private readonly lyricCache: TtlCache<string, LyricResult>
  private readonly picCache: TtlCache<string, string>
  private readonly urlFlight = new Singleflight<string, UrlResult>()
  private readonly lyricFlight = new Singleflight<string, LyricResult>()
  private readonly picFlight = new Singleflight<string, string>()
  private readonly searchFlight = new Singleflight<string, SearchResultData>()

  constructor(options: ResolverOptions) {
    this.registry = options.registry
    this.hooks = options.hooks ?? {}
    this.maxAttempts = options.maxAttempts ?? DEFAULT_LIMITS.maxAttempts
    const now = options.now
    this.urlCacheTtlMs = options.urlCacheTtlMs ?? 0
    this.urlCache = new TtlCache({ max: 200, ttlMs: this.urlCacheTtlMs, now })
    this.lyricCache = new TtlCache({ max: 200, ttlMs: options.lyricCacheTtlMs ?? 10 * 60_000, now })
    this.picCache = new TtlCache({ max: 300, ttlMs: options.picCacheTtlMs ?? 60 * 60_000, now })
  }

  private trackKey(source: LX.Source, id: string): string {
    return `${source}:${id}`
  }

  /**
   * 解析播放直链。降档顺序严格遵循规范阶梯；
   * 每次失败都记录在 attempts 里，UI 可以直接展示「为什么换源了」。
   */
  async resolveUrl(input: ResolveUrlInput): Promise<ResolveUrlResult> {
    const providers = this.registry.providersFor(input.source, 'url')
    if (!providers.length) throw noProviderError(input.source, 'url')

    const attempts: ResolveAttempt[] = []
    const cacheKey = `${input.source}:${input.id}:${input.quality ?? 'auto'}`
    const cached = this.urlCache.get(cacheKey)
    if (cached) {
      const provider = providers[0]
      return { value: cached, provider: provider.meta, attempts, source: input.source }
    }

    let lastError: LxspError | null = null

    for (const provider of providers) {
      if (attempts.length >= this.maxAttempts) break
      const candidates = pickCandidates(input.quality, provider.meta.qualities)
      let providerFatal = false

      for (const quality of candidates) {
        if (attempts.length >= this.maxAttempts) break
        const startedAt = Date.now()
        const query: UrlQuery = {
          source: input.source,
          id: input.id,
          name: input.name,
          singer: input.singer,
          album: input.album,
          duration: input.duration,
          quality,
          fallback: input.fallback,
        }
        try {
          const key = `url|${provider.meta.id}|${input.source}|${input.id}|${quality}`
          const resolved = await this.urlFlight.run(key, () => provider.resolveUrl(query, { trace: undefined }))
          // 降档事实必须在引擎层兜底复核：宁可多报一次降档，也不许静默降级
          const value = input.quality && isDowngrade(input.quality, resolved.quality)
            ? { ...resolved, downgraded: true }
            : resolved
          attempts.push({ providerId: provider.meta.id, source: input.source, quality, ok: true, elapsedMs: Date.now() - startedAt })
          this.hooks.onAttempt?.(attempts[attempts.length - 1]!)
          if (this.urlCacheTtlMs > 0) this.urlCache.set(cacheKey, value, this.urlCacheTtlMs)
          this.registry.markHealthy(provider.meta.id)
          this.hooks.rememberSource?.({ source: input.source, name: input.name ?? '', singer: input.singer ?? '' })
          return { value, provider: provider.meta, attempts, source: input.source }
        } catch (rawError) {
          const error = toLxspError(rawError, 'internal')
          lastError = error
          const attempt: ResolveAttempt = {
            providerId: provider.meta.id,
            source: input.source,
            quality,
            ok: false,
            code: error.code,
            message: error.message,
            elapsedMs: Date.now() - startedAt,
          }
          attempts.push(attempt)
          this.hooks.onAttempt?.(attempt)

          if (error.code === 'canceled' || error.code === 'bad_request') throw error
          if (error.policy.markBad) {
            this.registry.markUnhealthy(provider.meta.id, error.code)
            this.hooks.markUnhealthy?.(provider.meta.id, error.code)
          }
          if (error.policy.nextProvider) {
            // 传输层/鉴权/协议类错误：换镜像，别在同一端点上继续降档烧时间
            providerFatal = true
            break
          }
          if (!error.policy.nextQuality) break
        }
      }
      if (providerFatal) continue
    }

    throw lastError ?? new LxspError('not_found', `cannot resolve url for ${input.source}:${input.id}`, { source: input.source })
  }

  async getLyric(query: TrackQuery): Promise<ResolveResult<LyricResult>> {
    const providers = this.registry.providersFor(query.source, 'lyric')
    if (!providers.length) throw noProviderError(query.source, 'lyric')
    const key = this.trackKey(query.source, query.id)
    const cached = this.lyricCache.get(key)
    if (cached) return { value: cached, provider: providers[0]!.meta, attempts: [] }

    const attempts: ResolveAttempt[] = []
    let lastError: LxspError | null = null
    for (const provider of providers) {
      const startedAt = Date.now()
      try {
        const value = await this.lyricFlight.run(`${provider.meta.id}|${key}`, () => provider.lyric(query, {}))
        attempts.push({ providerId: provider.meta.id, source: query.source, ok: true, elapsedMs: Date.now() - startedAt })
        this.lyricCache.set(key, value)
        this.registry.markHealthy(provider.meta.id)
        return { value, provider: provider.meta, attempts }
      } catch (rawError) {
        const error = toLxspError(rawError, 'internal')
        lastError = error
        attempts.push({
          providerId: provider.meta.id,
          source: query.source,
          ok: false,
          code: error.code,
          message: error.message,
          elapsedMs: Date.now() - startedAt,
        })
        if (error.code === 'canceled' || error.code === 'bad_request') throw error
        if (error.policy.markBad) this.registry.markUnhealthy(provider.meta.id, error.code)
      }
    }
    throw lastError ?? new LxspError('not_found', `no lyric for ${key}`, { source: query.source })
  }

  async getPic(query: TrackQuery): Promise<ResolveResult<string>> {
    const providers = this.registry.providersFor(query.source, 'pic')
    if (!providers.length) throw noProviderError(query.source, 'pic')
    const key = this.trackKey(query.source, query.id)
    const cached = this.picCache.get(key)
    if (cached) return { value: cached, provider: providers[0]!.meta, attempts: [] }

    const attempts: ResolveAttempt[] = []
    let lastError: LxspError | null = null
    for (const provider of providers) {
      const startedAt = Date.now()
      try {
        const value = await this.picFlight.run(`${provider.meta.id}|${key}`, () => provider.pic(query, {}))
        attempts.push({ providerId: provider.meta.id, source: query.source, ok: true, elapsedMs: Date.now() - startedAt })
        this.picCache.set(key, value)
        this.registry.markHealthy(provider.meta.id)
        return { value, provider: provider.meta, attempts }
      } catch (rawError) {
        const error = toLxspError(rawError, 'internal')
        lastError = error
        attempts.push({
          providerId: provider.meta.id,
          source: query.source,
          ok: false,
          code: error.code,
          message: error.message,
          elapsedMs: Date.now() - startedAt,
        })
        if (error.code === 'canceled' || error.code === 'bad_request') throw error
        if (error.policy.markBad) this.registry.markUnhealthy(provider.meta.id, error.code)
      }
    }
    throw lastError ?? new LxspError('not_found', `no pic for ${key}`, { source: query.source })
  }

  async search(source: LX.Source, text: string, page: number, limit: number): Promise<ResolveResult<SearchResultData>> {
    const providers = this.registry.providersFor(source, 'search')
    if (!providers.length) throw noProviderError(source, 'search')

    const attempts: ResolveAttempt[] = []
    let lastError: LxspError | null = null
    for (const provider of providers) {
      const startedAt = Date.now()
      const key = `${provider.meta.id}|${source}|${page}|${limit}|${text}`
      try {
        const value = await this.searchFlight.run(key, () => provider.search({ text, page, limit }, {}))
        attempts.push({ providerId: provider.meta.id, source, ok: true, elapsedMs: Date.now() - startedAt })
        this.registry.markHealthy(provider.meta.id)
        return { value, provider: provider.meta, attempts }
      } catch (rawError) {
        const error = toLxspError(rawError, 'internal')
        lastError = error
        attempts.push({
          providerId: provider.meta.id,
          source,
          ok: false,
          code: error.code,
          message: error.message,
          elapsedMs: Date.now() - startedAt,
        })
        if (error.code === 'canceled' || error.code === 'bad_request') throw error
        if (error.policy.markBad) this.registry.markUnhealthy(provider.meta.id, error.code)
      }
    }
    throw lastError ?? new LxspError('not_found', `search failed for ${source}`, { source })
  }

  /** 供 UI 展示：当前音源链与健康度 */
  describe(source: LX.Source): Array<{ id: string, kind: string, endpoint?: string, priority: number, coolingDown: boolean, qualities: LX.Lxsp.Quality[] }> {
    return this.registry.providersFor(source).map(provider => ({
      id: provider.meta.id,
      kind: provider.meta.kind,
      endpoint: provider.meta.endpoint,
      priority: provider.meta.priority,
      coolingDown: this.registry.isCoolingDown(provider.meta.id),
      qualities: provider.meta.qualities,
    }))
  }

  isCoolingDown = (providerId: string): boolean => this.registry.isCoolingDown(providerId)
}
