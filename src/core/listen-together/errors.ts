/**
 * 一起听的唯一错误通道。
 *
 * 宪法：禁止吞异常。所以这里不是"catch 了就算了"，而是：
 *   - 保留最近 50 条（可观测）
 *   - 通过订阅通知 UI（错误日志区可见）
 *   - 每条带作用域，能定位到模块
 */
export interface ReportedError {
  scope: string
  message: string
  at: number
}

const MAX = 50
const ring: ReportedError[] = []
const listeners = new Set<(error: ReportedError) => void>()

export const reportError = (scope: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error)
  const item: ReportedError = { scope, message, at: Date.now() }
  ring.push(item)
  ring.length > MAX && ring.shift()
  for (const listener of listeners) listener(item)
}

export const onReportedError = (listener: (error: ReportedError) => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const recentErrors = (): ReportedError[] => [...ring]
