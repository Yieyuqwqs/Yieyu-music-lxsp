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

/** 生成追踪 id：前缀 + 时间戳 + 随机，足够日志对齐 */
export const createTraceId = (): string => `lx_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
