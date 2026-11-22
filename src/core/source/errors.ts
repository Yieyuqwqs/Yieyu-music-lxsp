/**
 * 统一错误模型：所有失败都必须落到 LXSP 错误码上。
 * 上层（UI / 播放器 / 日志）只认 code，不认字符串。
 */
import { ERROR_POLICY, type ErrorPolicy } from './protocol'

export class LxspError extends Error {
  readonly code: LX.Lxsp.ErrorCode
  readonly source?: LX.Source
  readonly quality?: LX.Lxsp.Quality
  readonly httpStatus?: number
  readonly retryAfterMs?: number
  readonly trace?: string
  readonly raw?: unknown

  constructor(code: LX.Lxsp.ErrorCode, message: string, extra?: {
    source?: LX.Source
    quality?: LX.Lxsp.Quality
    httpStatus?: number
    retryAfterMs?: number
    trace?: string
    raw?: unknown
  }) {
    super(message)
    this.name = 'LxspError'
    this.code = code
    if (extra) {
      this.source = extra.source
      this.quality = extra.quality
      this.httpStatus = extra.httpStatus
      this.retryAfterMs = extra.retryAfterMs
      this.trace = extra.trace
      this.raw = extra.raw
    }
    Object.setPrototypeOf(this, LxspError.prototype)
  }

  get policy(): ErrorPolicy {
    return ERROR_POLICY[this.code] ?? ERROR_POLICY.network
  }
}

export const isLxspError = (value: unknown): value is LxspError => value instanceof LxspError

/** 把任意抛出物归一成 LxspError，避免上层到处 instanceof 判断 */
export const toLxspError = (error: unknown, fallback: LX.Lxsp.ErrorCode = 'network'): LxspError => {
  if (error instanceof LxspError) return error
  const anyErr = error as { name?: string, message?: string, code?: string }
  if (anyErr?.name === 'AbortError' || anyErr?.code === 'ABORT_ERR') {
    return new LxspError('canceled', 'request canceled', { raw: error })
  }
  if (anyErr?.code === 'ETIMEDOUT') {
    return new LxspError('timeout', anyErr.message ?? 'timeout', { raw: error })
  }
  const message = typeof anyErr?.message === 'string' && anyErr.message ? anyErr.message : String(error)
  return new LxspError(fallback, message, { raw: error })
}

/** HTTP 状态 → 协议错误码（仅在响应体无法解析时兜底使用） */
export const fromHttpStatus = (status: number, body?: unknown): LxspError => {
  if (status === 401 || status === 403) return new LxspError('unauthorized', `HTTP ${status}`, { httpStatus: status, raw: body })
  if (status === 404) return new LxspError('not_found', `HTTP ${status}`, { httpStatus: status, raw: body })
  if (status === 408) return new LxspError('timeout', `HTTP ${status}`, { httpStatus: status, raw: body })
  if (status === 429) return new LxspError('rate_limited', `HTTP ${status}`, { httpStatus: status, raw: body })
  if (status === 400 || status === 422) return new LxspError('bad_request', `HTTP ${status}`, { httpStatus: status, raw: body })
  if (status >= 500) return new LxspError('upstream_error', `HTTP ${status}`, { httpStatus: status, raw: body })
  return new LxspError('bad_response', `HTTP ${status}`, { httpStatus: status, raw: body })
}
