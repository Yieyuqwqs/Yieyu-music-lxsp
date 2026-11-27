/**
 * 换源失败汇总（纯逻辑，node 可测）
 *
 * 根因：三条换源链路（URL / 封面 / 歌词）在每次失败时都只 `console.log(err)` 然后试下一个源，
 * 用户能看到的只有最后一句泛泛的「换源失败」。真实原因（unauthorized / upstream_denied / timeout）
 * 只留在 logcat 里 —— 用户和工单都拿不到它，排查就只能靠猜。
 *
 * 这里的规则：
 *   · 每一次失败都记成一条 AttemptFailure（音源 + 错误码 + 文本）；
 *   · 全部失败时抛 AllSourcesFailedError，message 里带着去重后的原因摘要；
 *   · attempts 挂在 error 上，UI/日志可以结构化读取，不需要解析字符串。
 *
 * 刻意不做的事：不在这里决定"要不要换源"（那是 resolver 的职责），也不吞异常。
 */

export interface AttemptFailure {
  /** 音源 id，例如 kg / wy / local */
  source: string
  /** LXSP 错误码或旧接口的错误标识，可能没有 */
  code?: string
  /** 人类可读的失败原因 */
  message: string
}

/** 摘要最多展示几条，避免状态栏被一长串原因撑爆 */
const MAX_DETAILS = 5

const oneLine = (text: string): string => String(text ?? '').replace(/\s+/g, ' ').trim()

/**
 * 把失败列表压成一行可读摘要：
 *   `kg:upstream_denied 版权 · wy:timeout 超时`
 * 同一个 (source, code, message) 只出现一次。
 */
export const describeAttempts = (attempts: readonly AttemptFailure[]): string => {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const attempt of attempts) {
    const source = oneLine(attempt.source) || 'unknown'
    const code = oneLine(attempt.code ?? '')
    const message = oneLine(attempt.message ?? '')
    const detail = code && message && !message.startsWith(code)
      ? `${code} ${message}`
      : (code || message || 'unknown')
    const key = `${source}|${detail}`
    if (seen.has(key)) continue
    seen.add(key)
    parts.push(`${source}:${detail}`)
    if (parts.length >= MAX_DETAILS) break
  }
  return parts.length ? parts.join(' / ') : 'unknown'
}

/** 全部音源都失败时的错误：带上结构化原因 */
export class AllSourcesFailedError extends Error {
  readonly code = 'all_sources_failed'
  readonly attempts: readonly AttemptFailure[]

  constructor(prefix: string, attempts: readonly AttemptFailure[]) {
    const head = oneLine(prefix) || 'all sources failed'
    super(`${head}：${describeAttempts(attempts)}`)
    this.name = 'AllSourcesFailedError'
    this.attempts = [...attempts]
    Object.setPrototypeOf(this, AllSourcesFailedError.prototype)
  }
}

/** 把任意抛出物归一成一条 AttemptFailure（不抛异常、不丢信息） */
export const toAttemptFailure = (source: string, error: unknown): AttemptFailure => {
  const value = error as { code?: unknown, message?: unknown } | null | undefined
  const code = typeof value?.code === 'string' && value.code ? value.code : undefined
  const message = typeof value?.message === 'string' && value.message
    ? value.message
    : (typeof error === 'string' ? error : 'unknown')
  return { source, code, message }
}

/**
 * 单条失败时按原样抛出（保持既有行为：tooManyRequests 之类的特判依赖 err.message），
 * 多条才包装成 AllSourcesFailedError。
 */
export const throwAttempts = (prefix: string, attempts: readonly AttemptFailure[], fallback?: unknown): never => {
  if (attempts.length <= 1 && fallback) throw fallback
  throw new AllSourcesFailedError(prefix, attempts)
}
