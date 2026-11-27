/**
 * 音源引擎（单例）：App 只跟它打交道。
 *
 * 它负责把「设置里的端点 + 内置兜底」装配成一个 Provider 集合，
 * 并把结果投影成旧代码仍在用的 global.lx.qualityList / apis(source) 形状，
 * 让上层界面、播放器、歌词、封面全部零改动地跑在新架构上。
 */
import { SourceRegistry } from './registry'
import { SourceResolver } from './resolver'
import { LxspTransport, resolveFetch, type FetchLike } from './transport'
import { detectEndpoint, type Detection } from './detect'
import { RemoteProvider } from './remote'

import { ApiProfileProvider } from './api-profiles'
import { WasmPluginProvider, type WasmBridge, type WasmPluginConfig } from './wasm-plugin'
import { toLegacyQuery, toLegacyMusicItem } from './local'
import { toLxspError } from './errors'
import { DEFAULT_LIMITS, checkEndpointSecurity, normalizeBaseUrl, redactUrl } from './protocol'
import type { ProviderHealth, SourceProvider } from './types'

/** 端点形态缓存有效期：10 分钟内重复重连不再探测 */
const DETECTION_TTL_MS = 10 * 60_000

export interface EngineEndpointConfig {
  /** 端点 base URL，例如 http://127.0.0.1:1101 */
  baseUrl: string
  /** 该端点专用 token（可选） */
  token?: string | null
}

export interface EngineInitOptions {
  endpoints: EngineEndpointConfig[]
  /** 全局 token（端点未单独指定时使用） */
  token?: string | null
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** WASM 音源插件（跑在原生 wasm3 里） */
  wasmPlugins?: WasmPluginConfig[]
  /** 原生 wasm 运行时桥（App 侧注入；测试可注入假实现） */
  wasmBridge?: WasmBridge
  /** 成功播放后记住音源 */
  rememberSource?: (info: { source: LX.Source, name: string, singer: string }) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface EndpointStatus {
  baseUrl: string
  ok: boolean
  provider?: string
  version?: string
  sources?: LX.Source[]
  error?: string
  latencyMs?: number
  health?: ProviderHealth['status']
}

export interface EngineInitResult {
  ok: boolean
  endpoints: EndpointStatus[]
  providerCount: number
  sources: LX.Source[]
  qualityList: LX.QualityList
}

const ONLINE_SOURCES: readonly LX.Source[] = ['kw', 'kg', 'tx', 'wy', 'mg']

export class SourceEngine {
  private registry = new SourceRegistry()
  private resolver = new SourceResolver({ registry: this.registry })
  private statuses: EndpointStatus[] = []
  private options: EngineInitOptions = { endpoints: [] }
  private inited = false
  /** 端点形态缓存：key = baseUrl|token，10 分钟内复用，避免每次重连都重新探测 */
  private detections = new Map<string, { detection: Detection, expireAt: number }>()
  private version = 1

  get isInited(): boolean {
    return this.inited
  }

  /** 每次 init 都重建注册表，保证换端点/换 token 后没有残留旧 Provider */
  async init(options: EngineInitOptions): Promise<EngineInitResult> {
    const log = options.onLog ?? (() => {})
    const registry = new SourceRegistry()
    const endpoints: EndpointStatus[] = []

    // 端点并行探测：最坏只等最慢的那一个端点，而不是「端点1 超时 + 端点2 超时 + …」。
    // 实测（每端点 300ms、2 个端点）：串行 604ms → 并行 ~305ms。
    // Promise.all 保序，所以 priority = index * 10 的含义不变。
    const perEndpoint = await Promise.all(
      options.endpoints.map((endpoint, index) => this.initOneEndpoint(endpoint, index, options, log)),
    )
    for (const item of perEndpoint) {
      if (item.status) endpoints.push(item.status)
      for (const provider of item.providers) registry.add(provider)
    }

    // WASM 插件：优先级最高（用户自己装的插件，排在所有端点前面）
    if (options.wasmPlugins?.length) {
      const bridge = options.wasmBridge
      const pluginFetch = options.fetchImpl ?? resolveFetch()
      if (bridge && pluginFetch) {
        for (const [index, config] of options.wasmPlugins.entries()) {
          try {
            const provider = await WasmPluginProvider.create({ config, bridge, priority: index, fetchImpl: pluginFetch })
            if (provider) {
              registry.add(provider)
              log('info', `wasm plugin ready: ${config.name ?? config.url} -> ${config.source}`)
            }
          } catch (error) {
            log('warn', `wasm plugin failed: ${config.url} -> ${(error as Error).message}`)
          }
        }
      } else {
        log('warn', 'wasm 插件已配置，但原生运行时不可用（用 API_URL 模式即可）')
      }
    }

    this.registry = registry
    this.resolver = new SourceResolver({
      registry,
      hooks: { rememberSource: options.rememberSource },
      // 直链缓存 120s：同一首歌反复播放/切歌回来不再打上游（过期直链由播放失败兜底换源）
      urlCacheTtlMs: 120_000,
    })
    this.statuses = endpoints
    this.options = options
    this.version += 1
    this.inited = true

    const qualityList = registry.qualityList()
    const sources = Object.keys(qualityList) as LX.Source[]
    // ok 的语义是「能不能出声」：没有任何音源具备 url 能力就是不可用
    const playable = ONLINE_SOURCES.filter(source => registry.has(source, 'url'))
    log(playable.length ? 'info' : 'warn', `source engine v${this.version}: ${registry.size} providers, ${endpoints.filter(item => item.ok).length}/${endpoints.length} endpoints, playable=${playable.join(',') || 'none'}`)

    return {
      ok: playable.length > 0,
      endpoints,
      providerCount: registry.size,
      sources,
      qualityList,
    }
  }

  /**
   * 单个端点的「探测 → Provider 装配」。
   *
   * 抽出来的原因：init 里原来是 for-await 串行跑每个端点，端点越多等越久；
   * 现在由 init 并行调用本方法，索引仍从原数组取（优先级语义不变）。
   */
  private async initOneEndpoint(
    endpoint: EngineEndpointConfig,
    index: number,
    options: EngineInitOptions,
    log: (level: 'info' | 'warn' | 'error', message: string) => void,
  ): Promise<{ status: EndpointStatus | null, providers: SourceProvider[] }> {
    const providers: SourceProvider[] = []
    const baseUrl = normalizeBaseUrl(endpoint.baseUrl)
    // 空地址不算端点：不占位、不报错（与旧行为一致）
    if (!baseUrl) return { status: null, providers }

    const startedAt = Date.now()
    // 安全闸门：公网地址不允许明文 http（lx-source 族把密钥放在 ?key= 里，明文等于公开密钥）
    const security = checkEndpointSecurity(baseUrl)
    if (!security.ok) {
      log('warn', `endpoint rejected by security policy: ${redactUrl(baseUrl)} -> ${security.reason ?? ''}`)
      return {
        status: { baseUrl, ok: false, error: `已按安全策略拦截：${security.reason ?? '地址不安全'}`, latencyMs: Date.now() - startedAt },
        providers,
      }
    }
    const token = endpoint.token ?? options.token ?? null
    const fetchImpl = options.fetchImpl ?? resolveFetch()
    if (!fetchImpl) {
      return { status: { baseUrl, ok: false, error: '当前环境没有 fetch 实现' }, providers }
    }

    const cacheKey = `${baseUrl}|${token ?? ''}`
    const hit = this.detections.get(cacheKey)
    let detection: Detection | null = hit && hit.expireAt > Date.now() ? hit.detection : null
    let detectError: string | undefined

    if (!detection) {
      // 并行探测：最坏只等一个超时，而不是「串行等四个」
      const detected = await detectEndpoint({
        baseUrl,
        token,
        fetchImpl,
        manifestTimeoutMs: Math.min(options.timeoutMs ?? DEFAULT_LIMITS.manifestTimeoutMs, 3500),
        profileTimeoutMs: 2500,
      })
      detection = detected.detection
      detectError = detected.error
      if (detection) this.detections.set(cacheKey, { detection, expireAt: Date.now() + DETECTION_TTL_MS })
      log('info', `endpoint detected in ${detected.elapsedMs}ms: ${baseUrl} -> ${detection ? (detection.kind === 'lxsp' ? 'lxsp' : detection.probe.profile) : 'unknown'}`)
    }

    if (!detection) {
      log('warn', `endpoint not recognised: ${baseUrl}`)
      return {
        status: {
          baseUrl,
          ok: false,
          error: `${detectError ?? '无法识别的端点'}（既不是 LXSP v2，也没认出任何已知接口：确认 API_URL 指向音源服务根地址）`,
          latencyMs: Date.now() - startedAt,
        },
        providers,
      }
    }

    if (detection.kind === 'lxsp') {
      const manifest = detection.manifest
      if (!manifest.auth && token) manifest.auth = { required: true, scheme: 'bearer' }
      const transport = manifest.auth
        ? new LxspTransport({
          baseUrl,
          token,
          auth: manifest.auth,
          timeoutMs: manifest.limits?.timeoutMs ?? options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
          fetchImpl,
        })
        : detection.transport
      for (const decl of manifest.sources) {
        providers.push(new RemoteProvider({
          transport,
          manifest,
          source: decl,
          priority: index * 10,
          timeoutMs: manifest.limits?.timeoutMs,
        }))
      }
      log('info', `LXSP endpoint ready: ${baseUrl} (${manifest.provider.id} v${manifest.provider.version}, ${manifest.sources.length} sources)`)
      return {
        status: {
          baseUrl,
          ok: true,
          provider: manifest.provider.name,
          version: manifest.provider.version,
          sources: manifest.sources.map(decl => decl.key),
          latencyMs: Date.now() - startedAt,
        },
        providers,
      }
    }

    const probe = detection.probe
    for (const decl of probe.sources) {
      providers.push(new ApiProfileProvider({
        probe,
        source: decl,
        token,
        priority: index * 10 + 5,
        fetchImpl,
      }))
    }
    log('info', `api profile ready: ${baseUrl} (${probe.profile}, ${probe.sources.length} sources)`)
    return {
      status: {
        baseUrl,
        ok: true,
        provider: probe.profile,
        version: probe.version,
        sources: probe.sources.map(decl => decl.key),
        latencyMs: Date.now() - startedAt,
      },
      providers,
    }
  }

  get resolverInstance(): SourceResolver {
    return this.resolver
  }

  get endpointStatus(): EndpointStatus[] {
    return this.statuses
  }

  get registryInstance(): SourceRegistry {
    return this.registry
  }

  qualityList(): LX.QualityList {
    return this.registry.qualityList()
  }

  hasUrlProvider(source: LX.Source): boolean {
    return this.registry.has(source, 'url')
  }

  /** 这个源有没有能搜索的 Provider（没有就该回落到内置实现，而不是给个空列表） */
  hasSearchProvider(source: LX.Source): boolean {
    return this.registry.has(source, 'search')
  }

  /**
   * 旧调用面兼容层：整个 App 里对「音源」的调用最终都落到这三个方法上，
   * 它们现在全部走统一的 resolver，不再有「脚本 / 内置」两套逻辑。
   */
  apis(source: LX.Source): Record<string, unknown> {
    const engineRef = this
    /**
     * 每个调用自带一个取消通道。
     * 以前 canceleFn 是空函数：切歌后旧解析还在跑，慢的那条回来还会覆盖新状态。
     */
    const makeCancel = () => {
      const Ctor = (globalThis as {
        AbortController?: new () => { signal: { readonly aborted: boolean }, abort: () => void }
      }).AbortController
      const controller = typeof Ctor === 'function' ? new Ctor() : null
      return {
        signal: controller?.signal as { readonly aborted: boolean } | undefined,
        cancel: () => { controller?.abort() },
      }
    }
    const track = (songInfo: unknown) => {
      const info = (songInfo && typeof songInfo === 'object' ? songInfo : {}) as Record<string, unknown>
      const legacy = toLegacyQuery(info)
      return {
        source,
        id: legacy.id,
        name: legacy.name,
        singer: legacy.singer,
        album: legacy.album,
        duration: legacy.duration,
      }
    }

    return {
      getMusicUrl(songInfo: unknown, quality: LX.Quality | null) {
        const query = track(songInfo)
        const cancel = makeCancel()
        const promise = engineRef.resolver.resolveUrl({ ...query, quality: quality ?? undefined, signal: cancel.signal })
          .then(result => ({
            type: result.value.quality,
            url: result.value.streamUrl ?? result.value.url,
            quality: result.value.quality,
            downgraded: result.value.downgraded,
            provider: result.provider.id,
          }))
          .catch((error: unknown) => {
            throw toLxspError(error, 'internal')
          })
        return { promise, canceleFn: cancel.cancel }
      },
      getLyric(songInfo: unknown) {
        const query = track(songInfo)
        const cancel = makeCancel()
        const promise = engineRef.resolver.getLyric(query, cancel.signal)
          .then((result): { lyric: string, tlyric: string, rlyric: string, lxlyric: string } => ({
            lyric: result.value.lrc,
            tlyric: result.value.tlrc ?? '',
            rlyric: result.value.rlrc ?? '',
            lxlyric: result.value.lxlrc ?? '',
          }))
          .catch((error: unknown) => {
            throw toLxspError(error, 'internal')
          })
        return { promise, canceleFn: cancel.cancel }
      },
      getPic(songInfo: unknown) {
        const query = track(songInfo)
        const cancel = makeCancel()
        const promise = engineRef.resolver.getPic(query, cancel.signal)
          .then(result => result.value)
          .catch((error: unknown) => {
            throw toLxspError(error, 'internal')
          })
        return { promise, canceleFn: cancel.cancel }
      },
    }
  }

  /** 搜索统一入口；返回旧 SearchResult 形状，界面零改动 */
  async search(source: LX.Source, text: string, page: number, limit: number): Promise<{ list: Record<string, unknown>[], total: number, allPage: number, limit: number, source: LX.Source }> {
    const result = await this.resolver.search(source, text, page, limit)
    const items = result.value.items.map(item => toLegacyMusicItem(source, item, result.provider.qualities))
    return {
      list: items,
      total: result.value.total ?? 0,
      allPage: result.value.hasMore ? page + 1 : page,
      limit: result.value.limit,
      source,
    }
  }

  /**
   * 端点健康探测（设置页「测试连接」用）。
   *
   * 根因修复：以前每个端点都拿「全局第一个可播 provider」去探自己，
   * 三个地址永远显示同一个 latency/health —— 数据是假的。
   * 现在只探「这个端点自己的」provider（靠 meta.endpoint 归属）。
   */
  async probe(): Promise<EndpointStatus[]> {
    const out: EndpointStatus[] = []
    const all = this.registry.all()
    for (const status of this.statuses) {
      if (!status.ok) {
        out.push(status)
        continue
      }
      const own = all.filter(provider => provider.meta.endpoint === status.baseUrl && provider.supports('url') && provider.health)
      const target = own[0]
      if (!target?.health) {
        // 这个端点的 provider 没有健康探测能力（例如 api-profile 族）：不编造 ok，保持 init 的真实结果
        out.push({ ...status })
        continue
      }
      try {
        const health = await target.health({})
        out.push({ ...status, health: health.status, latencyMs: health.latencyMs })
      } catch (error) {
        const lxError = toLxspError(error, 'network')
        // 服务端没有实现 /healthz 时抛 not_found/unsupported：这不是「挂了」，如实留空
        if (lxError.code === 'not_found' || lxError.code === 'unsupported') out.push({ ...status })
        else out.push({ ...status, health: 'down', error: lxError.message })
      }
    }
    return out
  }

  reset(): void {
    this.registry = new SourceRegistry()
    this.resolver = new SourceResolver({ registry: this.registry })
    this.statuses = []
    this.inited = false
    this.version += 1
  }
}

/** 全局单例：全 App 唯一音源引擎 */
export const sourceEngine = new SourceEngine()

/**
 * 端点配置串解析：支持换行/逗号分隔，支持 url|token 内联写法。
 *
 * 同一个 `baseUrl|token` 只保留第一次出现的：重复配置会让引擎给同一端点装配两套 Provider，
 * 容灾时会同时打两遍同样的请求（既浪费流量，也让"主/备"的优先级失去意义）。
 * 末尾斜杠差异视为同一端点（normalizeBaseUrl 之后比较）。
 */
export const parseEndpoints = (raw: string | undefined | null, fallbackToken?: string | null): EngineEndpointConfig[] => {
  if (!raw) return []
  const out: EngineEndpointConfig[] = []
  const seen = new Set<string>()
  for (const chunk of raw.split(/[\n,]+/)) {
    const entry = chunk.trim()
    if (!entry) continue
    const [url, token] = entry.split('|').map(part => part.trim())
    if (!url || !/^https?:\/\//i.test(url)) continue
    const resolvedToken = token || fallbackToken || null
    const dedupeKey = `${normalizeBaseUrl(url)}|${resolvedToken ?? ''}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({ baseUrl: url, token: resolvedToken })
  }
  return out
}

