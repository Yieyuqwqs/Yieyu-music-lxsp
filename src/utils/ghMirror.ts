// GitHub 国内直连 / 加速
//
// 这台手机上实测出来的结论（2026-11，移动网络）：
//   · api.github.com 直连        → 能用（约 0.9s）
//   · raw.githubusercontent.com  → 卡死（永远不返回）
//   · github.com（Release 资产） → 卡死
//   · jsDelivr / ghfast / kkgithub / gitmirror → 不通或超时
//   · gh-proxy.com 反代          → 能用（API 4s、APK 1.1s）
//   · ghproxy.net 反代           → 能用但慢（7s 起）
//
// 所以这里的策略是：
//   1. 所有请求都有硬超时（AbortController），绝不无限等；
//   2. 同一个地址展开成「直连 + 反代 + 镜像域名」的候选，**并发赛跑**，谁先给出合法数据用谁；
//   3. 候选顺序只当优先级提示（直连优先、实测可用的反代紧随其后）。
const API_HOST = 'api.github.com'
const WEB_HOST = 'github.com'
const RAW_HOST = 'raw.githubusercontent.com'

/** 反代前缀（按实测可用性排序，URL 直接拼在后面） */
const PROXY_PREFIXES = ['https://gh-proxy.com/', 'https://ghproxy.net/', 'https://ghfast.top/']
/** 与 github.com 同路径结构的镜像 */
const WEB_HOST_ALIASES = ['kkgithub.com']
/** 与 api.github.com 同路径结构的镜像 */
const API_HOST_ALIASES = ['api.kkgithub.com']
/** raw 的等价镜像 */
const RAW_HOST_ALIASES = ['raw.gitmirror.com']

const DEFAULT_TIMEOUT = 6000

/** 取 URL 的 host（Hermes 上 `new URL` 行为不完全一致，这里用正则） */
const hostOf = (url: string): string => {
  const match = String(url || '').match(/^[a-z]+:\/\/([^/?#]+)/i)
  return match ? match[1].toLowerCase() : ''
}

const replaceHost = (url: string, host: string): string => {
  const index = url.indexOf('://')
  if (index < 0) return url
  const rest = url.slice(index + 3)
  const slash = rest.indexOf('/')
  return `${url.slice(0, index + 3)}${host}${slash < 0 ? '' : rest.slice(slash)}`
}

/** raw.githubusercontent.com/<owner>/<repo>/<branch>/<path> → jsDelivr */
const toJsDelivr = (url: string): string | null => {
  const match = url.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/)
  if (!match) return null
  const [, owner, repo, branch, path] = match
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`
}

const unique = (list: string[]): string[] => list.filter((item, index) => !!item && list.indexOf(item) === index)

/** 同一个地址的等价候选（顺序 = 优先级，实际是并发赛跑） */
export const ghUrlCandidates = (url: string): string[] => {
  const list: string[] = [url]
  const host = hostOf(url)

  if (host === API_HOST) {
    // API 走反代经常被 GitHub 判 403，直连优先；反代作为兜底
    for (const prefix of PROXY_PREFIXES) list.push(prefix + url)
    for (const alias of API_HOST_ALIASES) list.push(replaceHost(url, alias))
  } else if (host === WEB_HOST) {
    for (const prefix of PROXY_PREFIXES) list.push(prefix + url)
    for (const alias of WEB_HOST_ALIASES) list.push(replaceHost(url, alias))
  } else if (host === RAW_HOST) {
    for (const prefix of PROXY_PREFIXES) list.push(prefix + url)
    for (const alias of RAW_HOST_ALIASES) list.push(replaceHost(url, alias))
    const jsdelivr = toJsDelivr(url)
    if (jsdelivr) list.push(jsdelivr)
  }

  return unique(list)
}

/** 大文件（APK）下载候选：反代优先，直连垫底 */
export const ghDownloadCandidates = (url: string): string[] => {
  const host = hostOf(url)
  if (host !== WEB_HOST) return ghUrlCandidates(url)
  const accelerated = PROXY_PREFIXES.map(prefix => prefix + url)
  const aliases = WEB_HOST_ALIASES.map(alias => replaceHost(url, alias))
  return unique([...accelerated, ...aliases, url])
}

export interface GhFetchOptions {
  timeoutMs?: number
  as?: 'json' | 'text'
  headers?: Record<string, string>
  validate?: (data: any) => boolean
}

/** 单次请求（硬超时，网络卡死也会在 timeoutMs 内失败） */
export const ghFetchOnce = async(url: string, options: GhFetchOptions = {}): Promise<any> => {
  const { timeoutMs = DEFAULT_TIMEOUT, as = 'json', headers, validate } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Yieyu-music',
        ...(headers || {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data: any = as === 'text' ? await res.text() : await res.json()
    if (validate && !validate(data)) throw new Error('返回内容不符合预期')
    return data
  } finally {
    clearTimeout(timer)
  }
}

const firstResolved = <T>(tasks: Array<Promise<T>>): Promise<T> => new Promise((resolve, reject) => {
  if (tasks.length === 0) { reject(new Error('没有可用的地址')); return }
  let pending = tasks.length
  let lastError: any = new Error('没有可用的地址')
  const fail = (error: any) => {
    if (error) lastError = error
    pending--
    if (pending === 0) reject(lastError)
  }
  for (const task of tasks) task.then(resolve, fail)
})

/** 多候选并发赛跑：第一个合法结果即返回；全失败才抛错 */
export const ghFetch = async(url: string, options: GhFetchOptions = {}): Promise<{ url: string, data: any }> => {
  const candidates = ghUrlCandidates(url)
  const tasks = candidates.map(candidate => ghFetchOnce(candidate, options).then(data => ({ url: candidate, data })))
  try {
    return await firstResolved(tasks)
  } catch (error) {
    console.warn('[ghMirror] 所有候选都失败:', url, (error as Error)?.message)
    throw error
  }
}

const decodeBase64 = (text: string): string => {
  try {
    const globalBuffer = (global as any).Buffer
    if (globalBuffer?.from) return globalBuffer.from(text, 'base64').toString('utf8')
  } catch {}
  try {
    const binary = (global as any).atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    // 只有纯 ASCII 的 JSON 才这么解（我们的清单都是纯 ASCII）
    let out = ''
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
    return out
  } catch {}
  return text
}

/**
 * 取仓库里的**文本文件**（version.json / whitelist.json / update.json…）。
 *
 * 优先用 contents API（带 Accept: raw）——实测这是国内唯一稳定的读法；
 * 反代/raw 作为兜底。如果反代把 Accept 头丢了、回的是 contents 信封
 * （{content: "base64"}），这里自动解开。
 */
export const ghFetchRawText = async(url: string, options: GhFetchOptions = {}): Promise<string> => {
  const { data } = await ghFetch(url, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
    as: 'text',
    headers: { Accept: 'application/vnd.github.raw', ...(options.headers || {}) },
  })
  let text = String(data ?? '')
  if (text.trimStart().startsWith('{') && text.includes('"content"')) {
    try {
      const envelope = JSON.parse(text)
      if (envelope && typeof envelope.content === 'string') text = decodeBase64(envelope.content.replace(/\s/g, ''))
    } catch {}
  }
  return text
}
