/**
 * 旧脚本后端兼容层：用 API_URL + API_KEY 覆盖社区里所有主流的「音源脚本后端」。
 *
 * 老生态里脚本五花八门，但真正干活的后端就那么几族；这里按「先探测、后使用」把它们收敛成 Provider，
 * App 里一行脚本都不执行，用户只填两个字段。
 *
 *   1. api-wwwweb    POST {base}/music/url  {source,musicId,quality} + X-Api-Key → {code:200,url}
 *   2. lx-source     GET  {base}/api/v0/    （自述 source 表）+ /api/v0/url/{source}/{id}/{quality}?key= → {code:0,data,ext.qual}
 *   3. api-json      POST {base}/api/parse | /url  {source,id,quality} → 取 url / data.url
 *
 * 新版 LXSP v2（有 /manifest）优先，本层只在没有 /manifest 时启用 —— 两套并存，谁也没被删掉。
 */
import { LxspError } from './errors'
import { sortQualitiesDesc } from './quality'
import { DEFAULT_LIMITS, PROFILE_PRIORITY, normalizeBaseUrl } from './protocol'
import type { FetchLike } from './transport'
import type { LyricResult, ProviderMeta, RequestContext, SearchResultData, SourceProvider, TrackQuery, UrlQuery, UrlResult } from './types'

export type ApiProfileId = 'api-wwwweb' | 'lx-source' | 'api-json'

export interface ProfileSourceDecl {
  key: LX.Source
  qualities: LX.Lxsp.Quality[]
}

export interface ApiProfileProbe {
  profile: ApiProfileId
  baseUrl: string
  sources: ProfileSourceDecl[]
  version?: string
}

const SOURCE_NAMES: Partial<Record<LX.Source, string>> = {
  wy: '网易云音乐', tx: 'QQ音乐', kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐',
}

const ALL_SOURCES: LX.Source[] = ['kg', 'kw', 'tx', 'wy', 'mg']

const DEFAULT_SOURCES: ProfileSourceDecl[] = [
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
  const httpStatus = typeof code === 'number' && code < 100 ? undefined : (typeof code === 'number' ? code : undefined)
  if (code === 401 || code === 403 || /密钥|鉴权|验证失败|api.?key|unauthorized/i.test(text)) {
    return new LxspError('unauthorized', text || '密钥无效', { httpStatus })
  }
  if (/VIP|版权|付费|地区|下架/i.test(text)) return new LxspError('upstream_denied', text, { httpStatus })
  if (/未找到|不存在|无歌词|无封面|not.?found|404/i.test(text)) return new LxspError('not_found', text, { httpStatus })
  if (/过速|429|限流/i.test(text)) return new LxspError('rate_limited', text, { httpStatus })
  if (/超时|timeout/i.test(text)) return new LxspError('timeout', text, { httpStatus })
  return new LxspError('upstream_error', text || '接口解析失败', { httpStatus })
}

interface CallOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  timeoutMs?: number
  signal?: RequestContext['signal']
  token?: string | null
  /**
   * 鉴权放在哪里。
   *
   * 重要：这里**故意不再提供 "both"**。以前每个请求都同时发 X-Api-Key + Authorization + ?key=，
   * 同一个密钥在一趟请求里出现三次，泄漏面直接 ×3（网关日志里就能看到 ?key=）。
   * 现在按族只发一种：
   *   · lx-source：只发 query（实测 header/bearer 都是 403，协议硬要求）
   *   · wwwweb / api-json：只发 header
   */
  auth?: 'header' | 'bearer' | 'query'
}

const callApi = async(fetchImpl: FetchLike, url: string, options: CallOptions): Promise<{ status: number, body: Record<string, unknown> | null }> => {
  const controller = (globalThis as { AbortController?: new () => { signal: unknown, abort: () => void } }).AbortController
  const abort = controller ? new controller() : null
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs
  let timer: ReturnType<typeof setTimeout> | null = null
  // 外部取消必须传导到这条请求上：以前只用 abort.signal，传进来的 options.signal 被丢掉了
  if (abort && options.signal?.addEventListener) {
    options.signal.addEventListener('abort', () => abort.abort())
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const token = options.token ?? null
  const auth = options.auth ?? 'header'
  let target = url
  if (token) {
    // 只发一种：同族的后端各吃一种，多余的头/参数不但没用，还会把密钥重复暴露
    if (auth === 'header') headers['X-Api-Key'] = token
    else if (auth === 'bearer') headers.Authorization = `Bearer ${token}`
    else if (auth === 'query') target += (target.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(token)
  }

  try {
    const response = await Promise.race([
      fetchImpl(target, {
        method: options.method ?? 'GET',
        headers,
        signal: (abort?.signal ?? options.signal) as never,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort?.abort()
          reject(new LxspError('timeout', `接口超时 ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
    const text = typeof response.text === 'function' ? await response.text() : ''
    let parsed: unknown = null
    try { parsed = text ? JSON.parse(text) : null } catch (e) { parsed = null }
    return { status: response.status ?? 0, body: asRecord(parsed) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 从响应里挑第一个像直链的字段（兼容各家不同字段名） */
const extractUrl = (body: Record<string, unknown> | null): string => {
  if (!body) return ''
  const candidates: unknown[] = [body.url, body.data, body.music, body.src, body.playUrl]
  const data = asRecord(body.data)
  if (data) candidates.push(data.url, data.music, data.src, data.playUrl)
  const nested = asRecord(data?.data)
  if (nested) candidates.push(nested.url, nested.music, nested.src)
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate
  }
  return ''
}

const extractMessage = (body: Record<string, unknown> | null): string => {
  if (!body) return ''
  const candidates = [body.message, body.msg, body.error, body.info]
  const data = asRecord(body.data)
  if (data) candidates.push(data.message, data.msg, data.error)
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return ''
}

const extractCode = (body: Record<string, unknown> | null): number | undefined => {
  if (!body) return undefined
  if (typeof body.code === 'number') return body.code
  if (typeof body.status === 'number') return body.status
  const data = asRecord(body.data)
  if (data && typeof data.code === 'number') return data.code
  return undefined
}

/**
 * 依次探测三族后端；返回第一个认出的。
 * 探测请求都用「必然失败但能区分路由」的参数，不会消耗真实解析额度。
 */
/** 探测结果按「优先级 + 短窗口」收敛：不串行等、也不因为快而用错族 */
const settleByPriority = async <T,>(
  entries: Array<{ priority: number, run: () => Promise<T | null> }>,
  graceMs: number,
): Promise<T | null> => new Promise<T | null>((resolve) => {
  let pending = entries.length
  let best: { priority: number, value: T } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let done = false

  const finish = () => {
    if (done) return
    done = true
    if (timer) { clearTimeout(timer); timer = null }
    resolve(best ? best.value : null)
  }

  const arm = () => {
    if (!best || timer) return
    // 最高优先级已经到手，没有任何候选能胜出，立刻收口
    if (best.priority === 0) { finish(); return }
    timer = setTimeout(finish, Math.max(0, graceMs))
  }

  for (const entry of entries) {
    entry.run().then((value) => {
      if (value && (!best || entry.priority < best.priority)) {
        best = { priority: entry.priority, value }
        arm()
      }
    }, () => {}).finally(() => {
      pending -= 1
      if (pending === 0) finish()
    })
  }
})

/**
 * 三族后端并行探测；返回优先级最高的那个。
 *
 * 历史：三族是串行 await 的（lx-source → wwwweb → /api/parse → /url），
 * 每次 2500ms 上限 ⇒ 单端点最坏 10s。现在四路并发，最坏只等最长的一路。
 */
export const probeApiProfiles = async(options: {
  baseUrl: string
  token?: string | null
  fetchImpl: FetchLike
  timeoutMs?: number
  /** 低优先级族先到后，等高优先级族的窗口；默认 200ms */
  graceMs?: number
}): Promise<ApiProfileProbe | null> => {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const timeoutMs = Math.min(options.timeoutMs ?? 6000, 8000)
  const fetchImpl = options.fetchImpl
  const token = options.token ?? null
  const graceMs = options.graceMs ?? 200

  // 1) lx-source 系：/api/v0/ 会回一份自述 JSON
  const probeLxSource = async(): Promise<ApiProfileProbe | null> => {
    const result = await callApi(fetchImpl, `${baseUrl}/api/v0/`, { timeoutMs, token, auth: 'query' })
    const sourceMap = result.body ? asRecord(result.body.source) : null
    if (!sourceMap) return null
    const sources: ProfileSourceDecl[] = []
    for (const [key, value] of Object.entries(sourceMap)) {
      if (!Array.isArray(value) || !value.length) continue
      if (!ALL_SOURCES.includes(key as LX.Source)) continue
      const qualities = sortQualitiesDesc(value.map(item => String(item).toLowerCase()).filter(item => item !== 'orig'))
      if (qualities.length) sources.push({ key: key as LX.Source, qualities })
    }
    if (!sources.length) return null
    return {
      profile: 'lx-source',
      baseUrl,
      sources,
      version: result.body && typeof result.body.version === 'string' ? result.body.version : undefined,
    }
  }

  // 2) wwwweb 系：POST /music/url
  const probeWwwweb = async(): Promise<ApiProfileProbe | null> => {
    const result = await callApi(fetchImpl, `${baseUrl}/music/url`, {
      method: 'POST',
      body: { source: 'kw', musicId: '0', quality: '128k' },
      timeoutMs,
      token,
      auth: 'header',
    })
    const body = result.body
    if (!body) return null
    if (extractCode(body) === undefined && !extractUrl(body)) return null
    return { profile: 'api-wwwweb', baseUrl, sources: DEFAULT_SOURCES }
  }

  // 3) 通用 JSON 接口：/api/parse 与 /url 并行（谁先给出可识别响应就用谁）
  const tryJsonPath = async(path: string): Promise<ApiProfileProbe | null> => {
    const result = await callApi(fetchImpl, `${baseUrl}${path}`, {
      method: 'POST',
      body: { source: 'kw', id: '0', quality: '128k', musicId: '0' },
      timeoutMs,
      token,
      auth: 'header',
    })
    const body = result.body
    if (body && (extractCode(body) !== undefined || !!extractUrl(body))) {
      return { profile: 'api-json', baseUrl, sources: DEFAULT_SOURCES }
    }
    return null
  }
  const probeJson = async(): Promise<ApiProfileProbe | null> => {
    return new Promise<ApiProfileProbe | null>((resolve) => {
      let pending = 2
      const done = (value: ApiProfileProbe | null) => {
        pending -= 1
        if (value) resolve(value)
        else if (pending === 0) resolve(null)
      }
      for (const path of ['/api/parse', '/url']) {
        tryJsonPath(path).then(done, () => done(null))
      }
    })
  }

  return settleByPriority([
    { priority: PROFILE_PRIORITY['lx-source']!, run: probeLxSource },
    { priority: PROFILE_PRIORITY['api-wwwweb']!, run: probeWwwweb },
    { priority: PROFILE_PRIORITY['api-json']!, run: probeJson },
  ], graceMs)
}

export interface ApiProfileProviderOptions {
  probe: ApiProfileProbe
  source: ProfileSourceDecl
  token?: string | null
  priority: number
  fetchImpl: FetchLike
  timeoutMs?: number
}

export class ApiProfileProvider implements SourceProvider {
  readonly meta: ProviderMeta
  private readonly probe: ApiProfileProbe
  private readonly token?: string | null
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number

  constructor(options: ApiProfileProviderOptions) {
    this.probe = options.probe
    this.token = options.token
    this.fetchImpl = options.fetchImpl
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs
    const capabilities: LX.Lxsp.Capability[] = this.probe.profile === 'lx-source' ? ['url', 'lyric', 'pic'] : ['url']
    this.meta = {
      id: `${this.probe.profile}:${this.probe.baseUrl}:${options.source.key}`,
      providerId: this.probe.profile,
      name: `${this.probe.profile}（${SOURCE_NAMES[options.source.key] ?? options.source.key}）`,
      version: this.probe.version ?? '1',
      kind: 'lxsp',
      endpoint: this.probe.baseUrl,
      source: options.source.key,
      priority: options.priority,
      qualities: options.source.qualities,
      capabilities,
    }
  }

  supports(capability: LX.Lxsp.Capability): boolean {
    return this.meta.capabilities.includes(capability)
  }

  private get isLxSource(): boolean {
    return this.probe.profile === 'lx-source'
  }

  async resolveUrl(query: UrlQuery, ctx: RequestContext = {}): Promise<UrlResult> {
    const quality = query.quality ?? '320k'
    const requested = query.quality ?? 'auto'
    const timeoutMs = ctx.timeoutMs ?? this.timeoutMs

    let body: Record<string, unknown> | null = null
    let status = 0

    if (this.isLxSource) {
      const result = await callApi(this.fetchImpl, `${this.probe.baseUrl}/api/v0/url/${query.source}/${encodeURIComponent(query.id)}/${encodeURIComponent(quality)}`, {
        token: this.token, auth: 'query', timeoutMs, signal: ctx.signal,
      })
      body = result.body
      status = result.status
    } else {
      const path = this.probe.profile === 'api-wwwweb' ? '/music/url' : '/api/parse'
      const payload = this.probe.profile === 'api-wwwweb'
        ? { source: query.source, musicId: query.id, quality, name: query.name, singer: query.singer }
        : { source: query.source, id: query.id, musicId: query.id, quality, name: query.name, singer: query.singer }
      const result = await callApi(this.fetchImpl, `${this.probe.baseUrl}${path}`, {
        method: 'POST', body: payload, token: this.token, auth: 'header', timeoutMs, signal: ctx.signal,
      })
      body = result.body
      status = result.status
      // api-json 族里有些后端用 GET /url/{source}/{id}
      if (!extractUrl(body)) {
        try {
          const fallback = await callApi(this.fetchImpl, `${this.probe.baseUrl}/url/${query.source}/${encodeURIComponent(query.id)}?quality=${encodeURIComponent(quality)}`, {
            token: this.token, auth: 'header', timeoutMs, signal: ctx.signal,
          })
          if (extractUrl(fallback.body)) {
            body = fallback.body
            status = fallback.status
          }
        } catch (error) { /* 保持原结果 */ }
      }
    }

    const url = extractUrl(body)
    if (!url) throw mapError(extractMessage(body) || '接口没有返回直链', extractCode(body) ?? status)

    const ext = body ? asRecord(body.ext) : null
    const actual = (ext && typeof ext.qual === 'string' ? ext.qual.toLowerCase() : quality)
    const canonical = (actual === 'hires' ? 'flac24bit' : actual) as LX.Lxsp.Quality
    return {
      url,
      quality: canonical,
      requestedQuality: requested,
      downgraded: requested !== 'auto' && sortQualitiesDesc([canonical, requested])[0] === requested,
      expiresAt: ext && typeof ext.expi === 'number' ? ext.expi as number : undefined,
      detail: { format: /\.flac(\?|$)/i.test(url) ? 'flac' : (/\.mp3(\?|$)/i.test(url) ? 'mp3' : null) },
      via: { upstream: `${this.probe.profile}:${quality}`, cache: 'upstream', coalesced: false },
    }
  }

  async lyric(query: TrackQuery, ctx: RequestContext = {}): Promise<LyricResult> {
    if (!this.isLxSource) throw new LxspError('unsupported', '该接口未声明歌词能力')
    const result = await callApi(this.fetchImpl, `${this.probe.baseUrl}/api/v0/lrc/${query.source}/${encodeURIComponent(query.id)}/`, {
      token: this.token, auth: 'query', timeoutMs: ctx.timeoutMs ?? this.timeoutMs, signal: ctx.signal,
    })
    const data = result.body && typeof result.body.data === 'string' ? result.body.data : ''
    if (!data) throw mapError(extractMessage(result.body) || '无歌词', extractCode(result.body) ?? result.status)
    return { lrc: data, format: 'lrc' }
  }

  async pic(query: TrackQuery, ctx: RequestContext = {}): Promise<string> {
    if (!this.isLxSource) throw new LxspError('unsupported', '该接口未声明封面能力')
    const result = await callApi(this.fetchImpl, `${this.probe.baseUrl}/api/v0/pic/${query.source}/${encodeURIComponent(query.id)}/`, {
      token: this.token, auth: 'query', timeoutMs: ctx.timeoutMs ?? this.timeoutMs, signal: ctx.signal,
    })
    const data = result.body && typeof result.body.data === 'string' ? result.body.data : ''
    if (!/^https?:\/\//i.test(data)) throw mapError(extractMessage(result.body) || '无封面', extractCode(result.body) ?? result.status)
    return data
  }

  async search(): Promise<SearchResultData> {
    throw new LxspError('unsupported', '该接口未声明搜索能力')
  }
}

export { DEFAULT_SOURCES }
