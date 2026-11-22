/**
 * 音质解析与降档：唯一的权威实现。
 * 客户端、服务端、UI 都必须走这里，避免「各写一套排序」。
 */
import { QUALITY_LADDER, QUALITY_ALIASES } from './protocol'

const LADDER_INDEX: Record<string, number> = {}
QUALITY_LADDER.forEach((quality, index) => { LADDER_INDEX[quality] = index })

/** 归一任意字符串到规范音质；无法识别返回 null */
export const normalizeQuality = (raw: unknown): LX.Lxsp.Quality | null => {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  if (!key) return null
  if (LADDER_INDEX[key] !== undefined) return key as LX.Lxsp.Quality
  return QUALITY_ALIASES[key] ?? null
}

/** 阶梯序号，越小越好；未知返回 +Infinity */
export const qualityRank = (quality: unknown): number => {
  const normalized = normalizeQuality(quality)
  return normalized ? LADDER_INDEX[normalized] : Number.POSITIVE_INFINITY
}

export const compareQuality = (a: unknown, b: unknown): number => qualityRank(a) - qualityRank(b)

/** 降档判定：服务端给出的比请求的差 */
export const isDowngrade = (requested: unknown, served: unknown): boolean => {
  if (requested === 'auto' || requested === null || requested === undefined) return false
  const r = qualityRank(requested)
  const s = qualityRank(served)
  if (!Number.isFinite(r) || !Number.isFinite(s)) return false
  return s > r
}

/** 去重 + 按规范阶梯降序（好的在前），丢弃无法识别的项 */
export const sortQualitiesDesc = (list: readonly unknown[]): LX.Lxsp.Quality[] => {
  const set = new Set<LX.Lxsp.Quality>()
  for (const item of list) {
    const normalized = normalizeQuality(item)
    if (normalized) set.add(normalized)
  }
  return [...set].sort(compareQuality)
}

/**
 * 生成候选音质序列（从设置档位开始向下降档）。
 * - setting=auto 时从最高档开始；
 * - 只保留 available 里真实存在的音质；
 * - 若设置档位高于该源最高音质（available 全在其之下），则允许降档（返回 available 全量降序）。
 */
export const pickCandidates = (
  setting: LX.QualitySetting | LX.Lxsp.Quality | undefined,
  available: readonly unknown[],
): LX.Lxsp.Quality[] => {
  const pool = sortQualitiesDesc(available)
  if (!pool.length) return ['128k']

  let startIndex = 0
  if (setting && setting !== 'auto') {
    const index = qualityRank(setting)
    startIndex = Number.isFinite(index) ? index : 0
  }
  const inRange = pool.filter(quality => qualityRank(quality) >= startIndex)
  return inRange.length ? inRange : pool
}

/** 最高可用音质（用于「自动」档位展示） */
export const bestQuality = (available: readonly unknown[]): LX.Lxsp.Quality | null => sortQualitiesDesc(available)[0] ?? null

/** 音质 → 展示档位（128k/320k/flac/flac24bit 等直接沿用 LX 文案键） */
export const qualityLabelKey = (quality: LX.Lxsp.Quality): string => `quality_${quality}`
