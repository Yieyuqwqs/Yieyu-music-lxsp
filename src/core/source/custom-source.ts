/**
 * 通用 API 源（配置驱动）：用户只填「地址 + 密钥 + 提取规则」，就能把任意解析服务器
 * 当成一个音源用，不需要为每个后端写适配器，更不需要执行谁的脚本。
 *
 * 配置示例（存进设置 common.customSources，JSON 数组）：
 * {
 *   "name": "某某解析",
 *   "baseUrl": "https://api.example.com",
 *   "token": "xxxx",
 *   "source": "kw",
 *   "qualities": ["flac", "320k", "128k"],
 *   "request": {
 *     "method": "POST",
 *     "path": "/api/parse",
 *     "body": { "id": "{id}", "src": "{source}", "q": "{quality}" },
 *     "headers": { "Referer": "https://music.example.com/" },
 *     "auth": { "in": "header", "name": "X-Api-Key" }
 *   },
 *   "response": { "url": "$.data.url", "quality": "$.data.quality", "error": "$.msg" }
 * }
 */
import { LxspError } from './errors'
import { pick, pickString } from './jsonpath'
import { normalizeQuality, sortQualitiesDesc } from './quality'
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

export interface CustomSourceRequest {
  method?: 'GET' | 'POST'
  /** 支持占位符：{source} {id} {quality} {name} {singer} */
  path: string
  /** 查询参数；值可用占位符 */
  query?: Record<string, string>
  /** 请求体字段；值可用占位符（method=POST 时生效） */
  body?: Record<string, string>
  headers?: Record<string, string>
  auth?: {
    in: 'header' | 'query' | 'none'
    /** in=header/query 时的字段名，默认 X-Api-Key / key */
    name?: string
  }
}

export interface CustomSourceResponse {
  /** 直链的 JSONPath，如 $.data.url */
  url: string
  /** 实际音质的 JSONPath（可选） */
  quality?: string
  /** 过期时间 JSONPath（可选，epoch 秒或 ISO） */
  expiresAt?: string
  /** 错误信息的 JSONPath（可选） */
  error?: string
  /** 成功判定（可选）：code.path 取到的值必须等于 code.ok 才算成功 */
  code?: { path: string, ok?: string | number | boolean }
}

export interface CustomSourceConfig {
  id?: string
  name?: string
  baseUrl: string
  token?: string
  source: LX.Source
  qualities?: string[]
  request: CustomSourceRequest
  response: CustomSourceResponse
  /** 优先级，越小越先试（默认 0：用户显式配置的排在远端端点前面） */
  priority?: number
}

const PLACEHOLDER = /\{(\w+)\}/g
const fill = (template: string, vars: Record<string, string | undefined>): string => (
  template.replace(PLACEHOLDER, (_all, key: string) => vars[key] ?? '')
)

const fillRecord = (record: Record<string, string> | undefined, vars: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!record) return out
  for (const [key, value] of Object.entries(record)) {
    const filled = fill(value, vars)
    if (filled !== '') out[key] = filled
  }
  return out
}

export const parseCustomSources = (raw: unknown): CustomSourceConfig[] => {
  if (!raw) return []
  let data: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return []
    try { data = JSON.parse(text) } catch (error) {
      throw new LxspError('bad_request', `自定义源配置不是合法 JSON：${(error as Error).message}`)
    }
  }
  const list = Array.isArray(data) ? data : [data]
  const out: CustomSourceConfig[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const config = item as Partial<CustomSourceConfig>
    if (!config.baseUrl || !config.request?.path || !config.response?.url) {
      throw new LxspError('bad_request', '自定义源缺少 baseUrl / request.path / response.url')
    }
    out.push({
      ...config,
      source: (config.source ?? 'kw') as LX.Source,
      baseUrl: normalizeBaseUrl(String(config.baseUrl)),
      qualities: Array.isArray(config.qualities) ? config.qualities : undefined,
      priority: typeof config.priority === 'number' ? config.priority : 0,
    })
  }
  return out
}

const mapError = (message: string, status?: number): LxspError => {
  const text = String(message || '')
  if (status === 401 || status === 403 || /密钥|鉴权|验证失败|unauthorized|api.?key/i.test(text)) {
    return new LxspError('unauthorized', text || '鉴权失败', { httpStatus: status })
  }
  if (/VIP|版权|付费|地区|下架/i.test(text)) return new LxspError('upstream_denied', text, { httpStatus: status })
  if (/未找到|不存在|无歌词|无封面|not.?found|404/i.test(text)) return new LxspError('not_found', text, { httpStatus: status })
  if (/过速|429|限流|rate/i.test(text)) return new LxspError('rate_limited', text, { httpStatus: status })
  if (/超时|timeout/i.test(text)) return new LxspError('timeout', text, { httpStatus: status })
  return new LxspError('upstream_error', text || '接口解析失败', { httpStatus: status })
}

export class CustomApiProvider implements SourceProvider {
  readonly meta: ProviderMeta
  private readonly config: CustomSourceConfig
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(options: { config: CustomSourceConfig, fetchImpl: FetchLike, timeoutMs?: number }) {
    this.config = options.config
    this.fetchImpl = options.fetchImpl
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs
    const qualities = sortQualitiesDesc(this.config.qualities ?? ['128k', '320k', 'flac'])
    this.meta = {
      id: `custom:${this.config.id ?? this.config.name ?? this.config.baseUrl}:${this.config.source}`,
      providerId: 'custom-api',
      name: this.config.name ?? `自定义源（${this.config.baseUrl}）`,
      version: '1',
      kind: 'lxsp',
      endpoint: this.config.baseUrl,
      source: this.config.source,
      priority: this.config.priority ?? 0,
      qualities,
      capabilities: ['url'],
    }
  }

  supports(capability: LX.Lxsp.Capability): boolean {
    return this.meta.capabilities.includes(capability)
  }

  private async request(query: UrlQuery, ctx: RequestContext = {}): Promise<{ status: number, body: unknown }> {
    const { request } = this.config
    const vars: Record<string, string | undefined> = {
      source: query.source,
      id: query.id,
      quality: query.quality,
      name: query.name,
      singer: query.singer,
      album: query.album,
      duration: query.duration === undefined ? undefined : String(query.duration),
    }
    const path = fill(request.path, vars)
    const search = new URLSearchParams(fillRecord(request.query, vars))
    const body = fillRecord(request.body, vars)
    const headers: Record<string, string> = { Accept: 'application/json', ...fillRecord(request.headers, vars) }

    const token = this.config.token
    if (token) {
      const auth = request.auth ?? { in: 'none' }
      if (auth.in === 'header') headers[auth.name ?? 'X-Api-Key'] = token
      else if (auth.in === 'query') search.set(auth.name ?? 'key', token)
    }

    const isPost = (request.method ?? (Object.keys(body).length ? 'POST' : 'GET')).toUpperCase() === 'POST'
    if (isPost) headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
    const url = `${this.config.baseUrl}${path.startsWith('/') ? path : '/' + path}${search.toString() ? '?' + search.toString() : ''}`

    const controller = (globalThis as { AbortController?: new () => { signal: unknown, abort: () => void } }).AbortController
    const abort = controller ? new controller() : null
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeoutMs = ctx.timeoutMs ?? this.timeoutMs
    try {
      const response = await Promise.race([
        this.fetchImpl(url, {
          method: isPost ? 'POST' : 'GET',
          headers,
          signal: (abort?.signal ?? ctx.signal) as RequestContext['signal'],
          body: isPost ? JSON.stringify(body) : undefined,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort?.abort()
            reject(new LxspError('timeout', `自定义源超时 ${timeoutMs}ms`))
          }, timeoutMs)
        }),
      ])
      const text = typeof response.text === 'function' ? await response.text() : ''
      let parsed: unknown = null
      try { parsed = text ? JSON.parse(text) : null } catch (e) { parsed = null }
      return { status: response.status ?? 0, body: parsed }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async resolveUrl(query: UrlQuery, ctx: RequestContext = {}): Promise<UrlResult> {
    const { status, body } = await this.request(query, ctx)
    const { response } = this.config

    if (response.code?.path) {
      const codeValue = pick(body, response.code.path)
      const expected = response.code.ok
      const matched = expected === undefined
        ? codeValue.found && Boolean(codeValue.value)
        : codeValue.found && String(codeValue.value) === String(expected)
      if (!matched) {
        const message = pickString(body, response.error) ?? `接口返回码不符合预期（${response.code.path}）`
        throw mapError(message, status)
      }
    }

    const url = pickString(body, response.url)
    if (!url || !/^https?:\/\//i.test(url)) {
      const message = pickString(body, response.error) ?? '没有提取到直链'
      throw mapError(message, status)
    }

    const requested = (query.quality ?? 'auto') as LX.Lxsp.Quality | 'auto'
    const actualRaw = pickString(body, response.quality)
    const actual = normalizeQuality(actualRaw) ?? (query.quality ?? '128k')
    return {
      url,
      quality: actual,
      requestedQuality: requested,
      downgraded: requested !== 'auto' && sortQualitiesDesc([actual, requested])[0] === requested,
      expiresAt: pickString(body, response.expiresAt) ?? undefined,
      detail: { format: /\.flac(\?|$)/i.test(url) ? 'flac' : (/\.mp3(\?|$)/i.test(url) ? 'mp3' : null) },
      via: { upstream: `custom:${this.config.name ?? this.config.baseUrl}`, cache: 'upstream', coalesced: false },
    }
  }

  async lyric(): Promise<LyricResult> {
    throw new LxspError('unsupported', '自定义源暂未配置歌词规则')
  }

  async pic(): Promise<string> {
    throw new LxspError('unsupported', '自定义源暂未配置封面规则')
  }

  async search(): Promise<SearchResultData> {
    throw new LxspError('unsupported', '自定义源暂未配置搜索规则')
  }
}
