/**
 * 标准 API 模式：只填 API_URL + API_KEY 就能用。
 *
 * 约定（和 c.wwwweb.top 这类后端一致，也是社区脚本默认的那套）：
 *   POST {API_URL}/music/url
 *   Header: X-Api-Key: {API_KEY}
 *   Body:   { "source": "kw", "musicId": "<id>", "quality": "320k" }
 *   成功:   { "code": 200, "url": "https://..." }
 *   失败:   { "code": 403, "message": "鉴权失败" }
 *
 * 端点不是 LXSP v2（没有 /manifest）时会自动走这里，所以用户不需要再懂协议。
 */
import { LxspError } from './errors'
import { sortQualitiesDesc } from './quality'
import { DEFAULT_LIMITS, normalizeBaseUrl } from './protocol'
import type { FetchLike } from './transport'
import type { LyricResult, ProviderMeta, RequestContext, SearchResultData, SourceProvider, TrackQuery, UrlQuery, UrlResult } from './types'

const SOURCE_NAMES: Partial<Record<LX.Source, string>> = {
  wy: '网易云音乐', tx: 'QQ音乐', kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐',
}

/** 标准 API 模式统一按这套能力表声明（后端没某项能力时会自己回错误，客户端按错误码处理） */
const STANDARD_SOURCES: Array<{ key: LX.Source, qualities: LX.Lxsp.Quality[] }> = [
  { key: 'kg', qualities: sortQualitiesDesc(['128k', '320k', 'flac', 'flac24bit', 'atmos', 'master']) },
  { key: 'kw', qualities: sortQualitiesDesc(['128k', '320k', 'flac', 'flac24bit']) },
  { key: 'tx', qualities: sortQualitiesDesc(['128k', '320k', 'flac', 'flac24bit', 'atmos', 'atmos_plus', 'master']) },
  { key: 'wy', qualities: sortQualitiesDesc(['128k', '320k', 'flac', 'flac24bit', 'atmos', 'master']) },
  { key: 'mg', qualities: sortQualitiesDesc(['128k', '320k', 'flac', 'flac24bit']) },
]

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
)

const mapError = (message: string, code?: number): LxspError => {
  const text = String(message || '')
  const httpStatus = typeof code === 'number' ? code : undefined
  if (code === 401 || code === 403 || /密钥|鉴权|验证失败|api.?key|unauthorized/i.test(text)) {
    return new LxspError('unauthorized', text || '密钥无效', { httpStatus })
  }
  if (/VIP|版权|付费|地区|下架/i.test(text)) return new LxspError('upstream_denied', text, { httpStatus })
  if (/未找到|不存在|无歌词|无封面|not.?found|404/i.test(text)) return new LxspError('not_found', text, { httpStatus })
  if (/过速|429|限流/i.test(text)) return new LxspError('rate_limited', text, { httpStatus })
  if (/超时|timeout/i.test(text)) return new LxspError('timeout', text, { httpStatus })
  return new LxspError('upstream_error', text || '接口解析失败', { httpStatus })
}

export interface StandardApiProbe {
  baseUrl: string
  needKey: boolean
}

/** 探测是不是「API_URL + API_KEY」这套接口 */
export const probeStandardApi = async(options: {
  baseUrl: string
  token?: string | null
  fetchImpl: FetchLike
  timeoutMs?: number
}): Promise<StandardApiProbe | null> => {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const timeoutMs = options.timeoutMs ?? 6000
  const controller = (globalThis as { AbortController?: new () => { signal: unknown, abort: () => void } }).AbortController
  const abort = controller ? new controller() : null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const response = await Promise.race([
      options.fetchImpl(`${baseUrl}/music/url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(options.token ? { 'X-Api-Key': options.token } : {}),
        },
        signal: abort?.signal as never,
        body: JSON.stringify({ source: 'kw', musicId: '0', quality: '128k' }),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort?.abort()
          reject(new Error('probe timeout'))
        }, timeoutMs)
      }),
    ])
    const text = typeof response.text === 'function' ? await response.text() : ''
    const body = asRecord(text ? JSON.parse(text) : null)
    // 只要它回的是「带 code/url/message 的 JSON」，就说明这套接口存在
    if (body && (typeof body.code === 'number' || typeof body.url === 'string' || typeof body.message === 'string' || typeof body.msg === 'string')) {
      return { baseUrl, needKey: true }
    }
    return null
  } catch (error) {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class StandardApiProvider implements SourceProvider {
  readonly meta: ProviderMeta
  private readonly baseUrl: string
  private readonly token?: string | null
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(options: { probe: StandardApiProbe, source: { key: LX.Source, qualities: LX.Lxsp.Quality[] }, token?: string | null, priority: number, fetchImpl: FetchLike, timeoutMs?: number }) {
    this.baseUrl = options.probe.baseUrl
    this.token = options.token
    this.fetchImpl = options.fetchImpl
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs
    this.meta = {
      id: `standard-api:${this.baseUrl}:${options.source.key}`,
      providerId: 'standard-api',
      name: `API 模式（${SOURCE_NAMES[options.source.key] ?? options.source.key}）`,
      version: '1',
      kind: 'lxsp',
      endpoint: this.baseUrl,
      source: options.source.key,
      priority: options.priority,
      qualities: options.source.qualities,
      capabilities: ['url'],
    }
  }

  supports(capability: LX.Lxsp.Capability): boolean {
    return this.meta.capabilities.includes(capability)
  }

  async resolveUrl(query: UrlQuery, ctx: RequestContext = {}): Promise<UrlResult> {
    const quality = query.quality ?? '320k'
    const controller = (globalThis as { AbortController?: new () => { signal: unknown, abort: () => void } }).AbortController
    const abort = controller ? new controller() : null
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeoutMs = ctx.timeoutMs ?? this.timeoutMs

    let status = 0
    let body: Record<string, unknown> | null = null
    try {
      const response = await Promise.race([
        this.fetchImpl(`${this.baseUrl}/music/url`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(this.token ? { 'X-Api-Key': this.token } : {}),
          },
          signal: (abort?.signal ?? ctx.signal) as never,
          body: JSON.stringify({ source: query.source, musicId: query.id, quality, name: query.name, singer: query.singer }),
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort?.abort()
            reject(new LxspError('timeout', `API 模式超时 ${timeoutMs}ms`))
          }, timeoutMs)
        }),
      ])
      status = response.status ?? 0
      const text = typeof response.text === 'function' ? await response.text() : ''
      body = asRecord(text ? JSON.parse(text) : null)
    } finally {
      if (timer) clearTimeout(timer)
    }

    const code = body && typeof body.code === 'number' ? body.code : undefined
    const message = String((body && (body.message ?? body.msg)) ?? '')
    const url = body && typeof body.url === 'string' ? body.url : ''
    if (!url || !/^https?:\/\//i.test(url)) throw mapError(message || 'API 模式没有返回直链', code)

    return {
      url,
      quality,
      requestedQuality: query.quality ?? 'auto',
      downgraded: false,
      detail: { format: /\.flac(\?|$)/i.test(url) ? 'flac' : (/\.mp3(\?|$)/i.test(url) ? 'mp3' : null) },
      via: { upstream: 'api-mode:' + quality, cache: 'upstream', coalesced: false },
    }
  }

  async lyric(): Promise<LyricResult> {
    throw new LxspError('unsupported', 'API 模式暂不提供歌词')
  }

  async pic(): Promise<string> {
    throw new LxspError('unsupported', 'API 模式暂不提供封面')
  }

  async search(): Promise<SearchResultData> {
    throw new LxspError('unsupported', 'API 模式暂不提供搜索')
  }
}

export { STANDARD_SOURCES }
