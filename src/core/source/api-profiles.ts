/**
 * 旧脚本后端兼容层：用 API_URL + API_KEY 覆盖社区里所有主流的「音源脚本后端」。
 *
 * 老生态里脚本五花八门，但真正干活的后端就那么几族；这里按「先探测、后使用」把它们收敛成 Provider，
 * App 里一行脚本都不执行，用户只填两个字段。
 *
 *   1. api-wwwweb    POST {base}/music/url  {source,musicId,quality} + X-Api-Key → {code:200,url}
 *   2. lx-source     GET  {base}/api/v0/    （自述 source 表）+ /api/v0/url/{source}/{id}/{quality} → {code:0,data,ext.qual}
 *                    鉴权走 X-LxM-Auth 头（实测与 ?key= 等价；用头后密钥不进 URL）
 *   3. api-json      POST {base}/api/parse | /url  {source,id,quality} → 取 url / data.url
 *
 * 新版 LXSP v2（有 /manifest）优先，本层只在没有 /manifest 时启用 —— 两套并存，谁也没被删掉。
 */
import { LxspError } from './errors'
import { sortQualitiesDesc } from './quality'
import {
  DEFAULT_LIMITS,
  LX_SOURCE_AUTH_HEADER,
  PROFILE_PRIORITY,
  isLxSourceSuccessCode,
  lxSourcePath,
  normalizeApiBase,
} from './protocol'
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
   * 鉴权放在哪里：只发 header，**永远不再往 URL 里拼 key**。
   *   · lx-source：X-LxM-Auth（实测与 ?key= 等价；用 header 后密钥不进日志）
   *   · wwwweb / api-json：X-Api-Key
   */
  auth?: 'header' | 'bearer'
  /** 覆盖默认 header 名（lx-source 用 X-LxM-Auth） */
  authHeader?: string
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
  const target = url
  if (token) {
    // 只发 header，且只发一种：URL 里不再出现任何密钥（?key= 会让网关日志、代理、浏览器历史全都留一份）
    if (auth === 'header') headers[options.authHeader ?? 'X-Api-Key'] = token
    else if (auth === 'bearer') headers.Authorization = `Bearer ${token}`
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
  // 前缀归一：用户把 .../api/v0 粘进来也只补一次，不会再拼成 /api/v0/api/v0
  const baseUrl = normalizeApiBase(options.baseUrl)
  const timeoutMs = Math.min(options.timeoutMs ?? 6000, 8000)
  const fetchImpl = options.fetchImpl
  const token = options.token ?? null
  const graceMs = options.graceMs ?? 200

  // 1) lx-source 系：/api/v0/ 会回一份自述 JSON
  const probeLxSource = async(): Promise<ApiProfileProbe | null> => {
    const result = await callApi(fetchImpl, lxSourcePath(baseUrl, '/'), { timeoutMs, token, auth: 'header', authHeader: LX_SOURCE_AUTH_HEADER })
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

  /** 组装返回值（lx-source 与其它族共用，避免复制一段 12 行的对象字面量） */
  private toUrlResult(directUrl: string, body: Record<string, unknown> | null, quality: string, requested: string, upstream: string): UrlResult {
    const ext = body ? asRecord(body.ext) : null
    const actual = (ext && typeof ext.qual === 'string' ? ext.qual.toLowerCase() : quality)
    const canonical = (actual === 'hires' ? 'flac24bit' : actual) as LX.Lxsp.Quality
    return {
      url: directUrl,
      quality: canonical,
      requestedQuality: requested,
      downgraded: requested !== 'auto' && sortQualitiesDesc([canonical, requested])[0] === requested,
      expiresAt: ext && typeof ext.expi === 'number' ? ext.expi as number : undefined,
      detail: { format: /\.flac(\?|$)/i.test(directUrl) ? 'flac' : (/\.mp3(\?|$)/i.test(directUrl) ? 'mp3' : null) },
      via: { upstream, cache: 'upstream', coalesced: false },
    }
  }

  /**
   * 用 /api/v0/mid/{source}/{id}/ 换「规范 id」。
   * 网关文档明确写了：mid 返回的 id「可能与传入参数不同」（MG: songId / KG: album_audio_id / TX: strMediaMid），
   * 而且 url 接口在 id 不对时会回 code 6「音乐ID校验失败」—— 这时换规范 id 再试一次才可能成功。
   * 注意末尾斜杠：不带会 301。
   */
  private async fetchCanonicalId(query: UrlQuery, ctx: RequestContext): Promise<string | null> {
    try {
      const result = await callApi(
        this.fetchImpl,
        lxSourcePath(this.probe.baseUrl, `/mid/${query.source}/${encodeURIComponent(query.id)}/`),
        { token: this.token, auth: 'header', authHeader: LX_SOURCE_AUTH_HEADER, timeoutMs: ctx.timeoutMs ?? this.timeoutMs, signal: ctx.signal },
      )
      if (!isLxSourceSuccessCode(extractCode(result.body))) return null
      const data = asRecord(result.body?.data)
      const id = data && typeof data.id === 'string' ? data.id.trim() : ''
      return id || null
    } catch (error) {
      return null
    }
  }

  async resolveUrl(query: UrlQuery, ctx: RequestContext = {}): Promise<UrlResult> {
    const quality = query.quality ?? '320k'
    const requested = query.quality ?? 'auto'
    const timeoutMs = ctx.timeoutMs ?? this.timeoutMs

    let body: Record<string, unknown> | null = null
    let status = 0

    if (this.isLxSource) {
      const askUrl = (id: string) => callApi(
        this.fetchImpl,
        lxSourcePath(this.probe.baseUrl, `/url/${query.source}/${encodeURIComponent(id)}/${encodeURIComponent(quality)}`),
        { token: this.token, auth: 'header', authHeader: LX_SOURCE_AUTH_HEADER, timeoutMs, signal: ctx.signal },
      )
      let result = await askUrl(query.id)
      try {
        // 成败看 code：失败时 data 里是 error.mp3 占位音，绝不能当直链
        const directUrl = readLxSourceUrl(result.body, result.status)
        return this.toUrlResult(directUrl, result.body, quality, requested, `lx-source:${quality}`)
      } catch (error) {
        const lxError = error as LxspError
        const idRejected = lxError.code === 'not_found' && /ID校验失败|id.*(invalid|校验)/i.test(lxError.message)
        if (!idRejected) throw error
        // 按文档用 mid 换规范 id 再试一次；换不到就直接把原始错误抛给上层（换源/降级）
        const canonicalId = await this.fetchCanonicalId(query, ctx)
        if (!canonicalId || canonicalId === query.id) throw error
        result = await askUrl(canonicalId)
        const directUrl = readLxSourceUrl(result.body, result.status)
        return this.toUrlResult(directUrl, result.body, quality, requested, `lx-source:${quality}(mid:${canonicalId})`)
      }
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
    // 其它族也可能回「错误占位音频」；一律不当作成功
    if (isErrorPlaceholderUrl(url)) throw mapError(extractMessage(body) || '接口返回的是错误占位音频', status)

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
    const result = await callApi(this.fetchImpl, lxSourcePath(this.probe.baseUrl, `/lrc/${query.source}/${encodeURIComponent(query.id)}/`), {
      token: this.token, auth: 'header', authHeader: LX_SOURCE_AUTH_HEADER, timeoutMs: ctx.timeoutMs ?? this.timeoutMs, signal: ctx.signal,
    })
    const data = result.body && typeof result.body.data === 'string' ? result.body.data : ''
    if (!data) throw mapError(extractMessage(result.body) || '无歌词', extractCode(result.body) ?? result.status)
    return { lrc: data, format: 'lrc' }
  }

  async pic(query: TrackQuery, ctx: RequestContext = {}): Promise<string> {
    if (!this.isLxSource) throw new LxspError('unsupported', '该接口未声明封面能力')
    const result = await callApi(this.fetchImpl, lxSourcePath(this.probe.baseUrl, `/pic/${query.source}/${encodeURIComponent(query.id)}/`), {
      token: this.token, auth: 'header', authHeader: LX_SOURCE_AUTH_HEADER, timeoutMs: ctx.timeoutMs ?? this.timeoutMs, signal: ctx.signal,
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

/**
 * 网关的「错误占位音频」判定。
 *
 * lx-source 失败时的响应长这样（真实抓包）：
 *   {"code":2,"msg":"404","data":"http://127.0.0.1:1101/api/v1/file/er/error.mp3?6b0a7164","ext":{"qual":"temp"}}
 * 也就是说 **data 里仍然是一个能播的 http 链接**。以前只判断「有没有 http 链接」，
 * 于是把这个错误提示音当成歌曲直链交给播放器 —— 表现就是"点了不出声/一秒就停"，而且不会换源。
 */
const isErrorPlaceholderUrl = (url: string): boolean => /\/er{1,2}or\.mp3|\/error\.mp3/i.test(url)

/**
 * 解析 lx-source 的响应：成功必须是 code === 0 且 data 是可用的 http 直链。
 * 抛出的错误带网关的真实 msg，UI 才能显示"为什么"。
 */
const readLxSourceUrl = (body: Record<string, unknown> | null, status: number): string => {
  const code = extractCode(body)
  const message = extractMessage(body)
  if (!isLxSourceSuccessCode(code)) {
    const text = message || `网关返回 code=${code}`
    // code 6 = 音乐ID校验失败（同一 id 换音质/换来源都没用），按 not_found 处理，快速换源
    if (/ID校验失败|id.*(invalid|校验)/i.test(text)) throw new LxspError('not_found', text, { httpStatus: status })
    // 该音质不可用：先在同一源内降档（flac → 320k → 128k），别直接换源
    // 实测网关在缺 flac 时回的就是 code:2 + msg:"404"
    if (/^404$|无此音质|音质不可用|不支持.*音质|quality/i.test(text.trim())) {
      throw new LxspError('quality_unavailable', text, { httpStatus: status })
    }
    throw mapError(text, status)
  }
  const url = extractUrl(body)
  if (!url) throw mapError(message || '接口没有返回直链', status)
  if (isErrorPlaceholderUrl(url)) {
    throw mapError(message || '网关返回的是错误占位音频', status)
  }
  return url
}
