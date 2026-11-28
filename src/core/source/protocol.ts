/**
 * LXSP v2 常量与词汇表（纯逻辑，无平台依赖，可在 node 下直接跑）
 */

/** 协议主版本；服务端 lxsp 字段为 `2.x` 即兼容 */
export const LXSP_MAJOR = 2
export const LXSP_VERSION = '2.0'

/** 默认路由；manifest.endpoints 可覆盖 */
export const LXSP_PATHS = {
  manifest: '/manifest',
  search: '/search',
  url: '/url',
  lyric: '/lyric',
  pic: '/pic',
  playlist: '/playlist',
  chart: '/chart',
  stream: '/stream',
  health: '/healthz',
} as const

/** 能力全集（顺序即声明顺序，无优先级含义） */
export const CAPABILITIES: readonly LX.Lxsp.Capability[] = ['search', 'url', 'lyric', 'pic', 'playlist', 'chart', 'stream']

/**
 * 音质规范阶梯：从高到低。这是唯一权威顺序，
 * 客户端降档、服务端降档、UI 排序都必须用它。
 */
export const QUALITY_LADDER: readonly LX.Lxsp.Quality[] = [
  'master',
  'atmos_plus',
  'atmos',
  'flac24bit',
  'wav',
  'flac',
  'ape',
  '320k',
  '192k',
  '128k',
]

/** 音质别名归一表：服务端自有词汇必须在出口前映射到规范词汇 */
export const QUALITY_ALIASES: Readonly<Record<string, LX.Lxsp.Quality>> = {
  lossless: 'flac',
  lossless_24bit: 'flac24bit',
  hires: 'flac24bit',
  hi_res: 'flac24bit',
  hires_lossless: 'flac24bit',
  '24bit': 'flac24bit',
  '24-bit': 'flac24bit',
  sq: 'flac',
  hq: '320k',
  high: '320k',
  std: '128k',
  standard: '128k',
  low: '128k',
  '320': '320k',
  '192': '192k',
  '128': '128k',
  dolby: 'atmos',
  // 网关文档里的音质别名（/doc/ 的音质表）
  fl24: 'flac24bit',
  sky: 'atmos_plus',
  atmos_plus_2: 'atmos_plus',
  zhenpin: 'master',
  maste: 'master',
}

/** 错误码 → 客户端处置策略。表里的每一项都是「协议的一部分」 */
export interface ErrorPolicy {
  /** 是否值得原样重试 */
  retryable: boolean
  /** 同一音源内是否继续降档（false 表示降档无意义） */
  nextQuality: boolean
  /** 是否换镜像/换源 */
  nextProvider: boolean
  /** 是否把该音源临时标记为不健康 */
  markBad: boolean
}

export const ERROR_POLICY: Readonly<Record<LX.Lxsp.ErrorCode, ErrorPolicy>> = {
  unsupported: { retryable: false, nextQuality: false, nextProvider: true, markBad: false },
  not_found: { retryable: false, nextQuality: false, nextProvider: true, markBad: false },
  quality_unavailable: { retryable: false, nextQuality: true, nextProvider: false, markBad: false },
  upstream_denied: { retryable: false, nextQuality: true, nextProvider: true, markBad: false },
  upstream_error: { retryable: true, nextQuality: true, nextProvider: true, markBad: false },
  rate_limited: { retryable: true, nextQuality: false, nextProvider: true, markBad: true },
  unauthorized: { retryable: false, nextQuality: false, nextProvider: true, markBad: true },
  timeout: { retryable: true, nextQuality: false, nextProvider: true, markBad: true },
  network: { retryable: true, nextQuality: false, nextProvider: true, markBad: true },
  bad_request: { retryable: false, nextQuality: false, nextProvider: false, markBad: false },
  bad_response: { retryable: false, nextQuality: false, nextProvider: true, markBad: true },
  canceled: { retryable: false, nextQuality: false, nextProvider: false, markBad: false },
  internal: { retryable: true, nextQuality: false, nextProvider: true, markBad: true },
}

/** 协议自带的默认限制；服务端只能收紧不能放宽 */
export const DEFAULT_LIMITS = {
  timeoutMs: 12_000,
  searchTimeoutMs: 15_000,
  manifestTimeoutMs: 8_000,
  maxPageSize: 50,
  /** 单次解析最多尝试多少个 (provider, quality) 组合 */
  maxAttempts: 12,
} as const

/** 去掉尾部斜杠，保证拼接稳定 */
export const normalizeBaseUrl = (base: string): string => base.trim().replace(/\/+$/, '')

/** 拼接 base + path，path 已是绝对路径时直接返回 */
export const joinUrl = (base: string, path: string): string => {
  if (/^https?:\/\//i.test(path)) return path
  return `${normalizeBaseUrl(base)}${path.startsWith('/') ? path : `/${path}`}`
}

/** 曲目元信息 → 查询串（跳过空值，保持可缓存性） */
export const toQuery = (params: Record<string, string | number | boolean | null | undefined>): string => {
  const parts: string[] = []
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (value === null || value === undefined || value === '') continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

/**
 * 旧接口族探测优先级：数字小的更可信。
 * 放在 protocol 里是刻意的——detect 与 api-profiles 都要用，
 * 谁也别 import 谁（否则就成了循环依赖）。
 */
export const PROFILE_PRIORITY: Readonly<Record<string, number>> = {
  'lx-source': 0,
  'api-wwwweb': 1,
  'api-json': 2,
}

/** 生成追踪 id：前缀 + 时间戳 + 随机，足够日志对齐 */
export const createTraceId = (): string => `lx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/* ------------------------- 安全策略（端点地址 / 日志脱敏） ------------------------- */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/** 取 host（不含端口）；Hermes 上 new URL 行为不稳，用正则 */
export const hostOf = (url: string): string => {
  const match = String(url ?? '').trim().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)
  if (!match) return ''
  let host = match[1].toLowerCase()
  // 去掉端口（IPv6 的 [::1]:8080 要单独处理）
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end < 0 ? host : host.slice(0, end + 1)
  }
  const colon = host.indexOf(':')
  return colon < 0 ? host : host.slice(0, colon)
}

/** 本机 / 局域网地址：这些地方用 http 是可接受的 */
export const isPrivateHost = (host: string): boolean => {
  const value = String(host ?? '').toLowerCase()
  if (!value) return false
  if (LOOPBACK_HOSTS.has(value)) return true
  if (value.endsWith('.local') || value.endsWith('.lan')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (!ipv4) return false
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
  if (a === 127 || a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true // 链路本地
  return false
}

export type EndpointSecurityLevel = 'secure' | 'local' | 'insecure' | 'invalid'

export interface EndpointSecurity {
  level: EndpointSecurityLevel
  /** 能否使用（insecure / invalid 为 false） */
  ok: boolean
  /** 给 UI 的说明（ok 时也可能有提醒） */
  reason?: string
}

/**
 * 端点地址的安全策略。
 *
 * 根因：lx-source 族只认 `?key=`（实测：header / bearer 都是 403），密钥必然出现在 URL 里 ——
 * 那么对公网地址用 http 就等于把密钥明文广播到链路上（网关日志也会原样打印）。
 * 所以：公网地址必须 https；本机/局域网地址允许 http（但 UI 会提醒）。
 */
export const checkEndpointSecurity = (baseUrl: string): EndpointSecurity => {
  const url = String(baseUrl ?? '').trim()
  if (!url) return { level: 'invalid', ok: false, reason: '地址为空' }
  const scheme = (/^([a-z][a-z0-9+.-]*):\/\//i.exec(url)?.[1] ?? '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    return { level: 'invalid', ok: false, reason: `只支持 http/https，实际是 ${scheme || '未知协议'}` }
  }
  const host = hostOf(url)
  if (!host) return { level: 'invalid', ok: false, reason: '地址里没有主机名' }
  if (scheme === 'https') return { level: 'secure', ok: true }
  if (isPrivateHost(host)) {
    return { level: 'local', ok: true, reason: '本机/局域网明文 http（密钥只在本机或局域网内传输）' }
  }
  return {
    level: 'insecure',
    ok: false,
    reason: `公网地址不允许明文 http（${host}）：lx-source 族把密钥放在 ?key= 里，明文传输等于公开密钥，请改用 https`,
  }
}

const SECRET_QUERY_KEYS = /^(key|token|apikey|api_key|api-key|access_token|auth|secret|pwd|password)$/i

/** 日志脱敏：把 URL 查询串里的密钥换成 ***，避免 key 进 logcat / 上报文件 */
export const redactUrl = (url: string): string => {
  const text = String(url ?? '')
  const index = text.indexOf('?')
  if (index < 0) return text
  const head = text.slice(0, index)
  const query = text.slice(index + 1)
  const masked = query.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    if (eq < 0) return pair
    const key = pair.slice(0, eq)
    return SECRET_QUERY_KEYS.test(decodeURIComponent(key)) ? `${key}=***` : pair
  })
  return `${head}?${masked.join('&')}`
}

/* ------------------------- lx-source 族的鉴权与路径 ------------------------- */

/**
 * lx-source 的鉴权头。
 *
 * 依据网关自己的接口文档（LX-Source 1.1.17，/doc/）：
 *   「key：接口密钥。**适用于无法设置请求头（X-Request-Key）的情况**（以及跳转调用）」
 * 所以官方头名是 X-Request-Key，?key= 只是兜底。
 *
 * 实测（本机网关）：X-Request-Key / X-LxM-Auth 都能 200，错误密钥都 403；
 * X-Api-Key / Bearer 则一律 403（不是这族认的头）。
 * 我们只发文档规定的这一个头 —— 密钥不再出现在 URL 里，也不会被网关日志原样打印。
 */
export const LX_SOURCE_AUTH_HEADER = 'X-Request-Key'

/**
 * 网关的「成功码」。
 * 文档原话：状态码目前同时混用两种规范 —— 原 LX-Source/Python 版的 enum 风格（0 = 成功）
 * 与 ikun 版的 http 风格（200 = 成功）。所以两个都认。
 */
export const isLxSourceSuccessCode = (code: number | undefined): boolean => code === undefined || code === 0 || code === 200

/** lx-source 的固定前缀：base 里如果已经带了，就不要再补一次 */
export const LX_SOURCE_API_PREFIX = '/api/v0'

/**
 * 归一化 API 根地址：
 *   http://h:1101            → http://h:1101
 *   http://h:1101/           → http://h:1101
 *   http://h:1101/api/v0     → http://h:1101
 *   http://h:1101/api/v0/    → http://h:1101
 * 这样拼出来永远是「恰好一个 /api/v0」，用户把带前缀的地址粘进来也不会 404。
 */
export const normalizeApiBase = (baseUrl: string): string => {
  let base = normalizeBaseUrl(baseUrl)
  const suffix = new RegExp(`${LX_SOURCE_API_PREFIX.replace('/', '\\/')}/*$`, 'i')
  base = base.replace(suffix, '')
  return normalizeBaseUrl(base)
}

/** 拼 lx-source 接口地址（前缀只出现一次） */
export const lxSourcePath = (baseUrl: string, path: string): string => {
  const base = normalizeApiBase(baseUrl)
  const tail = path.startsWith('/') ? path : `/${path}`
  return `${base}${LX_SOURCE_API_PREFIX}${tail}`
}
