/**
 * 音源引擎（单例）：App 只跟它打交道。
 *
 * 它负责把「设置里的端点 + 内置兜底」装配成一个 Provider 集合，
 * 并把结果投影成旧代码仍在用的 global.lx.qualityList / apis(source) 形状，
 * 让上层界面、播放器、歌词、封面全部零改动地跑在新架构上。
 */
import { SourceRegistry } from './registry'
import { SourceResolver } from './resolver'
import { LxspTransport, type FetchLike } from './transport'
import { RemoteProvider } from './remote'
import { parseManifest } from './manifest'
import { createLegacyProvider, toLegacyQuery, toLegacyMusicItem } from './local'
import { LxspError, toLxspError } from './errors'
import { DEFAULT_LIMITS, normalizeBaseUrl } from './protocol'
import type { ProviderHealth, SourceProvider } from './types'

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
  /** 是否挂载内置源兜底（默认挂） */
  enableLegacy?: boolean
  /** 内置源模块提供者（由调用方注入 musicSdk，避免 core/source 反向依赖） */
  getLegacySdk?: (source: LX.Source) => unknown
  fetchImpl?: FetchLike
  timeoutMs?: number
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

const LEGACY_PRIORITY = 900
const ONLINE_SOURCES: readonly LX.Source[] = ['kw', 'kg', 'tx', 'wy', 'mg']

export class SourceEngine {
  private registry = new SourceRegistry()
  private resolver = new SourceResolver({ registry: this.registry })
  private statuses: EndpointStatus[] = []
  private options: EngineInitOptions = { endpoints: [] }
  private inited = false
  private version = 1

  get isInited(): boolean {
    return this.inited
  }

  /** 每次 init 都重建注册表，保证换端点/换 token 后没有残留旧 Provider */
  async init(options: EngineInitOptions): Promise<EngineInitResult> {
    const log = options.onLog ?? (() => {})
    const registry = new SourceRegistry()
    const endpoints: EndpointStatus[] = []

    for (const [index, endpoint] of options.endpoints.entries()) {
      const baseUrl = normalizeBaseUrl(endpoint.baseUrl)
      if (!baseUrl) continue
      const startedAt = Date.now()
      try {
        const transport = new LxspTransport({
          baseUrl,
          token: endpoint.token ?? options.token ?? null,
          timeoutMs: options.timeoutMs ?? DEFAULT_LIMITS.manifestTimeoutMs,
          fetchImpl: options.fetchImpl,
        })
        const rawManifest = await transport.getJson<unknown>('/manifest', {}, { timeoutMs: options.timeoutMs ?? DEFAULT_LIMITS.manifestTimeoutMs })
        const manifest = parseManifest(rawManifest)

        // 未声明鉴权但配置了 token 时，按 bearer 处理（绝大多数部署如此）
        if (!manifest.auth && (endpoint.token ?? options.token)) {
          manifest.auth = { required: true, scheme: 'bearer' }
        }
        const providerTransport = manifest.auth
          ? new LxspTransport({
            baseUrl,
            token: endpoint.token ?? options.token ?? null,
            auth: manifest.auth,
            timeoutMs: manifest.limits?.timeoutMs ?? options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
            fetchImpl: options.fetchImpl,
          })
          : transport

        for (const decl of manifest.sources) {
          registry.add(new RemoteProvider({
            transport: providerTransport,
            manifest,
            source: decl,
            priority: index * 10,
            timeoutMs: manifest.limits?.timeoutMs,
          }))
        }
        endpoints.push({
          baseUrl,
          ok: true,
          provider: manifest.provider.name,
          version: manifest.provider.version,
          sources: manifest.sources.map(decl => decl.key),
          latencyMs: Date.now() - startedAt,
        })
        log('info', `LXSP endpoint ready: ${baseUrl} (${manifest.provider.id} v${manifest.provider.version}, ${manifest.sources.length} sources)`)
      } catch (error) {
        const lxErr = toLxspError(error, 'network')
        endpoints.push({ baseUrl, ok: false, error: `${lxErr.code}: ${lxErr.message}`, latencyMs: Date.now() - startedAt })
        log('warn', `LXSP endpoint failed: ${baseUrl} -> ${lxErr.code}: ${lxErr.message}`)
      }
    }

    if (options.enableLegacy !== false) {
      for (const source of ONLINE_SOURCES) {
        const provider: SourceProvider | null = createLegacyProvider(source, LEGACY_PRIORITY, options.getLegacySdk?.(source))
        if (provider) registry.add(provider)
      }
    }

    this.registry = registry
    this.resolver = new SourceResolver({
      registry,
      hooks: { rememberSource: options.rememberSource },
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

  /**
   * 旧调用面兼容层：整个 App 里对「音源」的调用最终都落到这三个方法上，
   * 它们现在全部走统一的 resolver，不再有「脚本 / 内置」两套逻辑。
   */
  apis(source: LX.Source): Record<string, unknown> {
    const engineRef = this
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
        const promise = engineRef.resolver.resolveUrl({ ...query, quality: quality ?? undefined })
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
        return { promise, canceleFn() {} }
      },
      getLyric(songInfo: unknown) {
        const query = track(songInfo)
        const promise = engineRef.resolver.getLyric(query)
          .then((result): { lyric: string, tlyric: string, rlyric: string, lxlyric: string } => ({
            lyric: result.value.lrc,
            tlyric: result.value.tlrc ?? '',
            rlyric: result.value.rlrc ?? '',
            lxlyric: result.value.lxlrc ?? '',
          }))
          .catch((error: unknown) => {
            throw toLxspError(error, 'internal')
          })
        return { promise, canceleFn() {} }
      },
      getPic(songInfo: unknown) {
        const query = track(songInfo)
        const promise = engineRef.resolver.getPic(query)
          .then(result => result.value)
          .catch((error: unknown) => {
            throw toLxspError(error, 'internal')
          })
        return { promise, canceleFn() {} }
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

  /** 端点健康探测（设置页/自检用） */
  async probe(): Promise<EndpointStatus[]> {
    const out: EndpointStatus[] = []
    for (const status of this.statuses) {
      if (!status.ok) {
        out.push(status)
        continue
      }
      const best = ONLINE_SOURCES.map(source => this.registry.best(source, 'url')).find(Boolean)
      if (!best?.health) {
        out.push(status)
        continue
      }
      try {
        const health = await best.health({})
        out.push({ ...status, health: health.status, latencyMs: health.latencyMs })
      } catch (error) {
        out.push({ ...status, health: 'down', error: toLxspError(error, 'network').message })
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

/** 端点配置串解析：支持换行/逗号分隔，支持 url|token 内联写法 */
export const parseEndpoints = (raw: string | undefined | null, fallbackToken?: string | null): EngineEndpointConfig[] => {
  if (!raw) return []
  const out: EngineEndpointConfig[] = []
  for (const chunk of raw.split(/[\n,]+/)) {
    const entry = chunk.trim()
    if (!entry) continue
    const [url, token] = entry.split('|').map(part => part.trim())
    if (!url || !/^https?:\/\//i.test(url)) continue
    out.push({ baseUrl: url, token: token || fallbackToken || null })
  }
  return out
}

