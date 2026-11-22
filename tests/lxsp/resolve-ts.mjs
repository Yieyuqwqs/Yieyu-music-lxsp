/**
 * 让 node 能直接跑 App 里的 TS 源码：
 * - 无扩展名相对导入补 .ts（App 里是 Metro 解析，node 里需要帮忙）
 * - 类型剥离由 node 24 原生完成
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CANDIDATES = ['.ts', '.tsx', '.js', '/index.ts', '/index.js']

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.(m?[jt]sx?|json)$/.test(specifier)) {
    const base = new URL(specifier, context.parentURL)
    for (const ext of CANDIDATES) {
      const candidate = new URL(base.href + ext)
      if (existsSync(fileURLToPath(candidate))) return next(base.href + ext, context)
    }
  }
  return next(specifier, context)
}
