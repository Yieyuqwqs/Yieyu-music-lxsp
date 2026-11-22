/**
 * 旧版 LX 音源 API 适配器（在 App 内直接支持，不需要外部门面）
 *
 * 现实里「别人的音源」有两代接口，且都没有 /manifest：
 *   1. wwwweb 系：POST /music/url  {source, musicId, quality} + X-Api-Key → {code:200, url}
 *   2. lx-source-next 系：GET /api/v0/url/{source}/{id}/{quality}?key= → {code:0, data:"url", ext:{qual,expi}}
 *
 * 这里把两代都探测出来并包装成标准 Provider，
 * 于是用户只要填「API 地址 + 密钥」就能用，404 不再出现。
 */
import { LxspError } from './errors'
import { sortQualitiesDesc } from './quality'
import { DEFAULT_LIMITS, normalizeBaseUrl } from './protocol'
import type { FetchLike } from './transport'
import type {
  LyricResult,
  ProviderMeta,
  RequestContext,
  SearchResultData,
  SourceProvider,
  TrackQuery,
  UrlQuery,
  UrlResult,
} from './types'

export type LegacyFlavor = 'wwwweb' | 'lx-source-next'

export interface LegacySourceDecl {
  key: LX.Source
  name: string
  qualities: LX.Lxsp.Quality[]
}

export interface LegacyProbe {
  flavor: LegacyFlavor
  baseUrl: string
  sources: LegacySourceDecl[]
  /** 该后端是否要求密钥 */
  needKey: boolean
  version?: string
}

const SOURCE_NAMES: Partial<Record<LX.Source, string>> = {
  wy: '网易云音乐', tx: 'QQ音乐', kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐',
}

/** wwwweb 系没有发现接口，按官方脚本里公开的能力表声明 */
const WWWEB_SOURCES: LegacySourceDecl[] = [
  { key: 'kg', name: '酷狗音乐', qualities: sortQualitiesDesc(['128k', '320k', 'flac', 'flac24bit', 'atmos', 'master']) },
  { key: 'kw', name: '酷我音乐', qualities: sortQualitiesDesc(['128k', '320k', 'flac', 'flac24bit']) },
  { key: 'tx', name: 'QQ音乐', qualities: sortQualitiesDesc(['128k', '320k', 'flac', 'flac24bit', 'atmos', 'atmos_plus', 'master']) },
  { key: 'wy', name: '网易云音乐', qualities: sortQualitiesDesc(['128k', '320k', 'flac', 'flac24bit', 'atmos', 'master']) },
  { key: 'mg', name: '咪咕音乐', qualities: sortQualitiesDesc(['128k', '320k', 'flac', 'flac24bit']) },
]

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
)

const isHttpUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//i.test(value)

/** 旧接口错误 → LXSP 错误码 */
const mapLegacyError = (message: string, status?: number): LxspError => {
  const text = String(message || '')
  if (status === 401 || status === 403 || /密钥|鉴权|验证失败|apikey|unauthorized/i.test(text)) {
    return new LxspError('unauthorized', text || '密钥无效', { httpStatus: status })
  }
  if (/VIP|版权|付费|地区|下架|无版权/i.test(text)) return new LxspError('upstream_denied', text, { httpStatus: status })
  if (/未找到|不存在|无歌词|无封面|404/i.test(text)) return new LxspError('not_found', text, { httpStatus: status })
  if (/过速|429|限流/i.test(text)) return new LxspError('rate_limited', text, { httpStatus: status })
  if (/超时|timeout/i.test(text)) return new LxspError('timeout', text, { httpStatus: status })
  return new LxspError('upstream_error', text || '旧接口解析失败', { httpStatus: status })
}

/** 统一的旧接口请求：同时带 X-Api-Key 与 ?key=（两代后端各吃一种） */
const legacyRequest = async(
  fetchImpl: FetchLike,
  baseUrl: string,
  token: string | null | undefined,
  options: { path: string, method?: 'GET' | 'POST', body?: unknown, timeoutMs?: number, signal?: RequestContext['signal'] },
): Promise<{ status: number, body: unknown }> => {
  const controller = (globalThis as { AbortController?: new () => { signal: unknown, abort: () => void } }).AbortController
  const abort = controller ? new controller() : null
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs
  let timer: ReturnType<typeof setTimeout> | null = null

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) {
    headers['X-Api-Key'] = token
    headers.Authorization = `Bearer ${token}`
  }
  const separator = options.path.includes('?') ? '&' : '?'
  const url = token ? `${baseUrl}${options.path}${separator}key=${encodeURIComponent(token)}` : `${baseUrl}${options.path}`

  try {
    const response = await Promise.race([
      fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        signal: (abort?.signal ?? options.signal) as RequestContext['signal'],
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort?.abort()
          reject(new LxspError('timeout', `legacy api timeout ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
    const text = typeof response.text === 'function' ? await response.text() : ''
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch (e) { body = null }
    return { status: response.status ?? 0, body }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 探测一个端点是不是旧版 LX 音源 API（LXSP 已失败时才会走到这里）。
 * 返回 null 表示「也不认识」，让引擎把该端点记为失败。
 */
export const probeLegacyApi = async(options: {
  baseUrl: string
  token?: string | null
  fetchImpl: FetchLike
  timeoutMs?: number
}): Promise<LegacyProbe | null> => {
  const baseUrl = normalizeBaseUrl(options.baseUrl)

  // 1) lx-source-next：/api/v0/ 会回一份自述 JSON（含 source 能力表）
  try {
    const result = await legacyRequest(options.fetchImpl, baseUrl, options.token, { path: '/api/v0/', timeoutMs: 6000 })
    const body = asRecord(result.body)
    const sourceMap = body ? asRecord(body.source) : null
    if (sourceMap) {
      const sources: LegacySourceDecl[] = []
      for (const [key, value] of Object.entries(sourceMap)) {
        if (!Array.isArray(value) || !value.length) continue
        if (!['kw', 'kg', 'tx', 'wy', 'mg'].includes(key)) continue
        const qualities = sortQualitiesDesc(value.map(item => String(item).toLowerCase()).filter(item => item !== 'orig'))
        if (!qualities.length) continue
        sources.push({ key: key as LX.Source, name: SOURCE_NAMES[key as LX.Source] ?? key, qualities })
      }
      if (sources.length) {
        return {
          flavor: 'lx-source-next',
          baseUrl,
          sources,
          needKey: !!(body && asRecord(body.auth) && (body.auth as Record<string, unknown>).apikey),
          version: typeof body?.version === 'string' ? body.version as string : undefined,
        }
      }
    }
  } catch (error) {
    // 继续尝试 wwwweb 探测
  }

  // 2) wwwweb 系：没有自述接口，用一个必然失败但能区分「认不认这个路由」的请求探
  try {
    const result = await legacyRequest(options.fetchImpl, baseUrl, options.token, {
      path: '/music/url',
      method: 'POST',
      body: { source: 'kw', musicId: '0', quality: '128k' },
      timeoutMs: 6000,
    })
    const body = asRecord(result.body)
    // 只要求它回了 JSON 且不是 404/网关错误：说明这个路由存在（code 200/403/429/500 都算认得）
    if (body && (typeof body.code === 'number' || typeof body.url === 'string' || typeof body.msg === 'string')) {
      return {
        flavor: 'wwwweb',
        baseUrl,
        sources: WWWEB_SOURCES,
        needKey: true,
      }
    }
  } catch (error) {
    // 两个都不认
  }

  return null
}

export interface LegacyProviderOptions {
  probe: LegacyProbe
  source: LegacySourceDecl
  token?: string | null
  priority: number
  fetchImpl: FetchLike
  timeoutMs?: number
}

export class LegacyApiProvider implements SourceProvider {
  readonly meta: ProviderMeta
  private readonly probe: LegacyProbe
  private readonly token?: string | null
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(options: LegacyProviderOptions) {
    this.probe = options.probe
    this.token = options.token
    this.fetchImpl = options.fetchImpl
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs
    this.meta = {
      id: `legacy-api:${options.probe.flavor}:${options.probe.baseUrl}:${options.source.key}`,
      providerId: `legacy-api:${options.probe.flavor}`,
      name: `${options.probe.flavor === 'wwwweb' ? 'wwwweb 音源' : 'lx-source 音源'}（${SOURCE_NAMES[options.source.key] ?? options.source.key}）`,
      version: options.probe.version ?? '1',
      kind: 'lxsp',
      endpoint: options.probe.baseUrl,
      source: options.source.key,
      priority: options.priority,
      qualities: options.source.qualities,
      capabilities: ['url', 'lyric', 'pic'],
    }
  }

  supports(capability: LX.Lxsp.Capability): boolean {
    return this.meta.capabilities.includes(capability)
  }

  private call(path: string, method: 'GET' | 'POST', body?: unknown, ctx: RequestContext = {}) {
    return legacyRequest(this.fetchImpl, this.probe.baseUrl, this.token, {
      path,
      method,
      body,
      timeoutMs: ctx.timeoutMs ?? this.timeoutMs,
      signal: ctx.signal,
    })
  }

  async resolveUrl(query: UrlQuery, ctx: RequestContext = {}): Promise<UrlResult> {
    const quality = query.quality ?? '320k'
    const requested = query.quality ?? 'auto'

    if (this.probe.flavor === 'lx-source-next') {
      const result = await this.call(`/api/v0/url/${query.source}/${encodeURIComponent(query.id)}/${encodeURIComponent(quality)}`, 'GET', undefined, ctx)
      const body = asRecord(result.body)
      const url = body && body.code === 0 && isHttpUrl(body.data) ? body.data : null
      if (!url) throw mapLegacyError(String((body && (body.msg ?? body.message)) ?? 'empty url'), result.status)
      const ext = asRecord(body?.ext)
      const actual = typeof ext?.qual === 'string' ? ext.qual.toLowerCase() : quality
      const canonical = (actual === 'hires' ? 'flac24bit' : actual) as LX.Lxsp.Quality
      return {
        url,
        quality: canonical,
        requestedQuality: requested,
        downgraded: canonical !== quality && sortQualitiesDesc([canonical, quality])[0] === quality,
        expiresAt: typeof ext?.expi === 'number' ? ext.expi as number : undefined,
        detail: { format: /\.flac(\?|$)/i.test(url) ? 'flac' : (/\.mp3(\?|$)/i.test(url) ? 'mp3' : null) },
        via: { upstream: 'lx-source-next:' + quality, cache: 'upstream', coalesced: false },
      }
    }

    const result = await this.call('/music/url', 'POST', {
      source: query.source,
      musicId: query.id,
      quality,
      name: query.name,
      singer: query.singer,
    }, ctx)
    const body = asRecord(result.body)
    const url = body && isHttpUrl(body.url) ? body.url : null
    if (!url) throw mapLegacyError(String((body && (body.message ?? body.msg)) ?? 'empty url'), result.status)
    return {
      url,
      quality,
      requestedQuality: requested,
      downgraded: false,
      detail: { format: /\.flac(\?|$)/i.test(url) ? 'flac' : (/\.mp3(\?|$)/i.test(url) ? 'mp3' : null) },
      via: { upstream: 'wwwweb:' + quality, cache: 'upstream', coalesced: false },
    }
  }

  async lyric(query: TrackQuery, ctx: RequestContext = {}): Promise<LyricResult> {
    const result = await this.call(`/api/v0/lrc/${query.source}/${encodeURIComponent(query.id)}/`, 'GET', undefined, ctx)
    const body = asRecord(result.body)
    const text = body && body.code === 0 && typeof body.data === 'string' ? body.data : ''
    if (!text) throw mapLegacyError(String((body && body.msg) ?? '无歌词'), result.status)
    return { lrc: text, format: 'lrc' }
  }

  async pic(query: TrackQuery, ctx: RequestContext = {}): Promise<string> {
    const result = await this.call(`/api/v0/pic/${query.source}/${encodeURIComponent(query.id)}/`, 'GET', undefined, ctx)
    const body = asRecord(result.body)
    const url = body && body.code === 0 && isHttpUrl(body.data) ? body.data : ''
    if (!url) throw mapLegacyError(String((body && body.msg) ?? '无封面'), result.status)
    return url
  }

  async search(): Promise<SearchResultData> {
    // 两代旧接口都没有稳定搜索能力：声明不支持，交给引擎换源
    throw new LxspError('unsupported', 'legacy api has no search capability')
  }
}

