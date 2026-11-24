// 让 node 直接跑 .ts（类型剥离），并给无扩展名相对导入补 .ts
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const CANDIDATES = ['.ts', '.tsx', '.js', '/index.ts']
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
