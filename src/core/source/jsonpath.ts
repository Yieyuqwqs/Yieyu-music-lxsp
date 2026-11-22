/**
 * 极简 JSONPath 取值器：只支持「配置里真正用得上」的语法。
 *   $.data.url
 *   $.result.songs[0].url
 *   $['data']['url']
 *   data.url      （省略 $ 也行）
 * 不支持过滤表达式/通配符 —— 音源配置不需要，也不该给用户一个半成品函数式语言。
 */
export interface PickResult {
  found: boolean
  value: unknown
}

const MISS: PickResult = { found: false, value: undefined }

const tokenize = (path: string): Array<string | number> => {
  const tokens: Array<string | number> = []
  let rest = path.trim()
  if (rest.startsWith('$')) rest = rest.slice(1)
  while (rest.length) {
    if (rest.startsWith('.')) { rest = rest.slice(1); continue }
    if (rest.startsWith('[')) {
      const close = rest.indexOf(']')
      if (close < 0) return tokens
      const inner = rest.slice(1, close).trim()
      if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
        tokens.push(inner.slice(1, -1))
      } else {
        const index = Number(inner)
        tokens.push(Number.isInteger(index) ? index : inner)
      }
      rest = rest.slice(close + 1)
      continue
    }
    const match = /^[^.[\]]+/.exec(rest)
    if (!match) break
    tokens.push(match[0])
    rest = rest.slice(match[0].length)
  }
  return tokens
}

/** 按路径取值；路径不合法或中途不存在都返回 found=false，绝不抛错 */
export const pick = (data: unknown, path: string | null | undefined): PickResult => {
  if (!path) return MISS
  const tokens = tokenize(path)
  if (!tokens.length) return MISS
  let current: unknown = data
  for (const token of tokens) {
    if (current === null || current === undefined) return MISS
    if (typeof token === 'number') {
      if (!Array.isArray(current)) return MISS
      current = current[token]
    } else {
      if (typeof current !== 'object') return MISS
      current = (current as Record<string, unknown>)[token]
    }
    if (current === undefined) return MISS
  }
  return { found: true, value: current }
}

/** 取字符串（找得到且是 string/number 才算命中） */
export const pickString = (data: unknown, path: string | null | undefined): string | null => {
  const result = pick(data, path)
  if (!result.found) return null
  if (typeof result.value === 'string') return result.value
  if (typeof result.value === 'number' && Number.isFinite(result.value)) return String(result.value)
  return null
}
