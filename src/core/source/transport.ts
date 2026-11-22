/**
 * LXSP 传输层：一个端点 = 一个 HTTP JSON 客户端。
 * 只做四件事：拼 URL、带鉴权、超时/取消、把信封拆成 data 或 LxspError。
 * 不做业务判断（那是 provider / resolver 的事）。
 */
import { DEFAULT_LIMITS, LXSP_VERSION, joinUrl, toQuery } from './protocol'
import { LxspError, fromHttpStatus, toLxspError } from './errors'
import type { AbortSignalLike } from './types'

export interface HttpRequestInit {
  method?: string
  headers?: Record<string, string>
  signal?: AbortSignalLike
}

export interface HttpResponseLike {
  status: number
  ok?: boolean
  headers?: { get?: (name: string) => string | null }
  text?: () => Promise<string>
  json?: () => Promise<unknown>
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>

export interface TransportOptions {
  baseUrl: string
  token?: string | null
  auth?: LX.Lxsp.Manifest['auth']
  headers?: Record<string, string>
  timeoutMs?: number
  fetchImpl?: FetchLike
}

export interface RequestOptions {
  signal?: AbortSignalLike
  timeoutMs?: number
  trace?: string
}

export const resolveFetch = (): FetchLike | null => {
  const globalFetch = (globalThis as { fetch?: FetchLike }).fetch
  return typeof globalFetch === 'function' ? globalFetch.bind(globalThis) : null
}

const createAbortController = (): { signal: AbortSignalLike, abort: () => void } | null => {
  const Ctor = (globalThis as { AbortController?: new () => { signal: AbortSignalLike, abort: () => void } }).AbortController
  return typeof Ctor === 'function' ? new Ctor() : null
}

/** 带超时的 fetch：超时/外部取消都归一成 LxspError，绝不悬挂 */
const fetchWithTimeout = async(
  fetchImpl: FetchLike,
  url: string,
  init: HttpRequestInit,
  options: RequestOptions & { timeoutMs: number },
): Promise<HttpResponseLike> => {
  const controller = createAbortController()
  const merged: HttpRequestInit = { ...init, signal: controller?.signal ?? options.signal }
  if (options.signal && controller?.signal) {
    options.signal.addEventListener?.('abort', () => controller.abort())
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      fetchImpl(url, merged),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller?.abort()
          reject(new LxspError('timeout', `timeout after ${options.timeoutMs}ms`, { trace: options.trace }))
        }, options.timeoutMs)
      }),
    ])
  } catch (error) {
    if (options.signal?.aborted) throw new LxspError('canceled', 'request canceled', { raw: error })
    const lxErr = toLxspError(error, 'network')
    if (lxErr.code === 'canceled') throw lxErr
    throw new LxspError(lxErr.code, lxErr.message, { trace: options.trace, raw: error })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const readBody = async(response: HttpResponseLike): Promise<unknown> => {
  try {
    if (typeof response.text === 'function') {
      const text = await response.text()
      if (!text) return null
      try {
        return JSON.parse(text)
      } catch (_) {
        return { __raw: text }
      }
    }
    if (typeof response.json === 'function') return await response.json()
  } catch (_) {
    return null
  }
  return null
}

export class LxspTransport {
  readonly baseUrl: string
  private readonly options: TransportOptions
  private readonly fetchImpl: FetchLike

  constructor(options: TransportOptions) {
    const fetchImpl = options.fetchImpl ?? resolveFetch()
    if (!fetchImpl) throw new LxspError('network', 'no fetch implementation available')
    this.options = options
    this.fetchImpl = fetchImpl
    this.baseUrl = options.baseUrl
  }

  /** 组装请求头（鉴权优先级：显式 headers > manifest.auth 声明） */
  buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Lxsp-Version': LXSP_VERSION,
      ...this.options.headers,
    }
    const token = this.options.token
    const auth = this.options.auth
    if (token && auth?.scheme !== 'query') {
      if (auth?.scheme === 'header' && auth.header) headers[auth.header] = token
      else headers.Authorization = `Bearer ${token}`
    }
    return headers
  }

  /** GET 一个信封接口，返回 data；失败抛 LxspError */
  async getJson<T>(
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
    options: RequestOptions = {},
  ): Promise<T> {
    const auth = this.options.auth
    const mergedQuery: Record<string, string | number | boolean | null | undefined> = { ...query }
    if (this.options.token && auth?.scheme === 'query') mergedQuery[auth.query ?? 'key'] = this.options.token

    const url = `${joinUrl(this.baseUrl, path)}${toQuery(mergedQuery)}`
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs

    let response: HttpResponseLike
    try {
      response = await fetchWithTimeout(this.fetchImpl, url, { method: 'GET', headers: this.buildHeaders() }, { ...options, timeoutMs })
    } catch (error) {
      throw toLxspError(error, 'network')
    }

    const status = response.status ?? 0
    const body = await readBody(response)
    const trace = (body as { trace?: string } | null)?.trace ?? response.headers?.get?.('x-lxsp-trace') ?? options.trace

    if (status >= 400) {
      const errorBody = (body as LX.Lxsp.Envelope<unknown> | null)?.error
      if (errorBody?.code) throw this.toError(errorBody, status, trace)
      throw fromHttpStatus(status, body)
    }

    const envelope = body as LX.Lxsp.Envelope<T> | null
    if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
      throw new LxspError('bad_response', 'invalid LXSP envelope', { httpStatus: status, trace, raw: body })
    }
    if (!envelope.ok) {
      if (envelope.error?.code) throw this.toError(envelope.error, status, trace)
      throw new LxspError('bad_response', 'LXSP error without code', { httpStatus: status, trace, raw: body })
    }
    if (envelope.data === undefined || envelope.data === null) {
      throw new LxspError('bad_response', 'LXSP ok response without data', { httpStatus: status, trace, raw: body })
    }
    return envelope.data
  }

  private toError(body: LX.Lxsp.ErrorBody, httpStatus: number, trace?: string): LxspError {
    const code = body.code
    return new LxspError(code, body.message || code, {
      source: body.source,
      quality: body.quality,
      httpStatus,
      retryAfterMs: body.retryAfterMs,
      trace,
      raw: body,
    })
  }
}
