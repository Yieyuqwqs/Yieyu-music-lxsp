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
  AbortSignalLike,
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
  /** 主源超过这个时间还没结果，就并发打下一路（默认 100ms，即「0.1 秒容灾」） */
  hedgeMs?: number
  now?: () => number
}

export interface ResolveUrlInput extends TrackQuery {
  quality?: LX.Lxsp.Quality
  /** 允许服务端跨平台兜底 */
  fallback?: boolean
  /** 取消信号：切歌/重试时上层可以主动放弃这条解析 */
  signal?: AbortSignalLike
}

/** 缓存条目：必须记住「是哪个 provider 给的」，否则命中时会错报来源 */
interface CachedUrl {
  value: UrlResult
  providerId: string
}

export class SourceResolver {
  private readonly registry: SourceRegistry
  private readonly hooks: ResolverHooks
  private readonly maxAttempts: number
  private readonly hedgeMs: number
  private readonly urlCacheTtlMs: number
  private readonly urlCache: TtlCache<string, CachedUrl>
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
    this.hedgeMs = options.hedgeMs ?? 100
    const now = options.now
    this.urlCacheTtlMs = options.urlCacheTtlMs ?? 0
    // 显式写类型参数：babel 不做类型检查，漏了也只有 tsc 才看得见，等于给未来的类型化埋雷
    this.urlCache = new TtlCache<string, CachedUrl>({ max: 200, ttlMs: this.urlCacheTtlMs, now })
    this.lyricCache = new TtlCache<string, LyricResult>({ max: 200, ttlMs: options.lyricCacheTtlMs ?? 10 * 60_000, now })
    this.picCache = new TtlCache<string, string>({ max: 300, ttlMs: options.picCacheTtlMs ?? 60 * 60_000, now })
  }

  private trackKey(source: LX.Source, id: string): string {
    return `${source}:${id}`
  }

  /**
   * 直链是否已经过期（或即将过期）。
   *
   * 根因：url 缓存以前只按 120s TTL 判断，完全不看服务端给的 expiresAt，
   * 于是"缓存还没到期、直链先过期"时会把死链喂给播放器（表现是点了不出声）。
   */
  private isUrlExpired(value: UrlResult, now = Date.now()): boolean {
    const raw = value.expiresAt
    if (raw === undefined || raw === null) return false
    let at = NaN
    if (typeof raw === 'number') at = raw > 1e12 ? raw : raw * 1000
    else at = Date.parse(String(raw))
    if (!Number.isFinite(at)) return false
    // 留 3 秒余量：播放器 seek/起播本身要时间，卡在边界上等于必失败
    return at - now <= 3000
  }

  /** 缓存写入时的 TTL：不越过服务端声明的过期时间 */
  private ttlFor(value: UrlResult, ttlMs: number, now = Date.now()): number {
    const raw = value.expiresAt
    if (raw === undefined || raw === null) return ttlMs
    const at = typeof raw === 'number' ? (raw > 1e12 ? raw : raw * 1000) : Date.parse(String(raw))
    if (!Number.isFinite(at)) return ttlMs
    return Math.max(0, Math.min(ttlMs, at - now))
  }

  /**
   * 解析播放直链。降档顺序严格遵循规范阶梯；
   * 每次失败都记录在 attempts 里，UI 可以直接展示「为什么换源了」。
   */
  /**
   * 单个 Provider 的完整尝试：音质降档 → 单飞 → 缓存回填 → 错误策略。
   * 抛错表示「这一路不行了」，交给 resolveUrl 决定补位还是收口。
   */
  private async attemptProvider(
    provider: SourceProvider,
    input: ResolveUrlInput,
    cacheKey: string,
    attempts: ResolveAttempt[],
  ): Promise<UrlResult> {
    const candidates = pickCandidates(input.quality, provider.meta.qualities)
    let lastError: LxspError | null = null

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
        const task = () => provider.resolveUrl(query, { trace: undefined, signal: input.signal })
        // 有取消信号时不合并请求：把一次可取消的请求共享给别的调用方，等于让它们一起被取消
        const resolved = input.signal
          ? await task()
          : await this.urlFlight.run(`url|${provider.meta.id}|${input.source}|${input.id}|${quality}`, task)
        // 降档事实必须在引擎层兜底复核：宁可多报一次降档，也不许静默降级
        const value = input.quality && isDowngrade(input.quality, resolved.quality)
          ? { ...resolved, downgraded: true }
          : resolved
        attempts.push({ providerId: provider.meta.id, source: input.source, quality, ok: true, elapsedMs: Date.now() - startedAt })
        this.hooks.onAttempt?.(attempts[attempts.length - 1]!)
        if (this.urlCacheTtlMs > 0 && !this.isUrlExpired(value)) {
          const ttl = this.ttlFor(value, this.urlCacheTtlMs)
          if (ttl > 0) this.urlCache.set(cacheKey, { value, providerId: provider.meta.id }, ttl)
        }
        this.registry.markHealthy(provider.meta.id)
        return value
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
        // nextProvider：传输层/鉴权/协议类错误，别在同一端点上继续降档烧时间
        // !nextQuality：降档也没意义，直接换源
        if (error.policy.nextProvider || !error.policy.nextQuality) throw lastError
      }
    }
    throw lastError ?? new LxspError('not_found', `cannot resolve url for ${input.source}:${input.id}`, { source: input.source })
  }

  /**
   * 解析播放直链，带「并发容灾」：
   * 主源立即发；超过 hedgeMs（默认 100ms）还没结果就并发打备用源，谁先成功用谁。
   * 主源「快速失败」时也不等间隔，立刻补位 —— 这正是「0.1 秒内切备用」的两条路径。
   */
  async resolveUrl(input: ResolveUrlInput): Promise<ResolveUrlResult> {
    const providers = this.registry.providersFor(input.source, 'url')
    if (!providers.length) throw noProviderError(input.source, 'url')

    if (input.signal?.aborted) throw new LxspError('canceled', 'resolve canceled before start', { source: input.source })

    const attempts: ResolveAttempt[] = []
    const cacheKey = `${input.source}:${input.id}:${input.quality ?? 'auto'}`
    const cached = this.urlCache.get(cacheKey)
    if (cached) {
      // 命中缓存也要报「真实来源」：以前一律报 providers[0]，主源挂了却显示主源成功
      const owner = this.registry.all().find(provider => provider.meta.id === cached.providerId)
      return { value: cached.value, provider: owner?.meta ?? providers[0]!.meta, attempts, source: input.source }
    }

    const hedgeMs = Math.max(0, this.hedgeMs)
    let nextIndex = 0
    let active = 0
    let done = false
    let lastError: LxspError | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    return await new Promise<ResolveUrlResult>((resolve, reject) => {
      const finish = (error?: LxspError | null, result?: ResolveUrlResult) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        timer = null
        if (result) resolve(result)
        else reject(error ?? new LxspError('not_found', `cannot resolve url for ${input.source}:${input.id}`, { source: input.source }))
      }

      const launch = (index: number) => {
        if (done || index >= providers.length) return
        const provider = providers[index]!
        active += 1
        void this.attemptProvider(provider, input, cacheKey, attempts).then((value) => {
          active -= 1
          if (done) return
          this.hooks.rememberSource?.({ source: input.source, name: input.name ?? '', singer: input.singer ?? '' })
          finish(null, { value, provider: provider.meta, attempts, source: input.source })
        }, (error: LxspError) => {
          active -= 1
          lastError = error
          if (done) return
          if (error.code === 'canceled') return finish(error)
          // 失败立刻补位，不等 hedge 间隔
          if (nextIndex < providers.length) {
            launch(nextIndex++)
            return
          }
          if (active === 0) finish(lastError)
        })
      }

      const schedule = () => {
        if (done || nextIndex >= providers.length) return
        timer = setTimeout(() => {
          if (done) return
          if (nextIndex < providers.length) {
            launch(nextIndex++)
            schedule()
          }
        }, hedgeMs)
      }

      launch(nextIndex++)
      schedule()
    })
  }

  async getLyric(query: TrackQuery, signal?: AbortSignalLike): Promise<ResolveResult<LyricResult>> {
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
        const runLyric = () => provider.lyric(query, { signal })
        const value = signal
          ? await runLyric()
          : await this.lyricFlight.run(`${provider.meta.id}|${key}`, runLyric)
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

  async getPic(query: TrackQuery, signal?: AbortSignalLike): Promise<ResolveResult<string>> {
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
        const runPic = () => provider.pic(query, { signal })
        const value = signal
          ? await runPic()
          : await this.picFlight.run(`${provider.meta.id}|${key}`, runPic)
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
