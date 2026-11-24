/**
 * 房间曲目 ↔ 本机曲目 的匹配（纯函数）
 *
 * 房间只传 { source, id, name, singer }；但同一首歌在不同设备上的 id 往往不同
 * （甚至可能来自不同平台），所以：
 *   1. 先按稳定键精确匹配（同平台同 id）
 *   2. 再按「歌名 + 歌手」模糊匹配，作为跨端兜底
 */
import type { TrackRef } from './protocol'

interface MusicInfoLike {
  id?: string
  source?: string
  name?: string
  singer?: string
  interval?: string | null
  meta?: { songId?: string } & Record<string, unknown>
}

const parseIntervalMs = (interval?: string | null): number => {
  if (!interval) return 0
  const parts = interval.split(':').map(part => Number.parseInt(part, 10)).filter(part => Number.isFinite(part))
  if (!parts.length) return 0
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return seconds * 1000
}

/** 时长差在 8 秒内算同一首（不同版本/无版权替换时常有 1-3 秒差） */
const durationMatches = (candidate: MusicInfoLike, target: { durationMs?: number }): boolean => {
  const targetMs = Number(target.durationMs) || 0
  const candidateMs = parseIntervalMs(candidate.interval)
  if (!targetMs || !candidateMs) return true // 有一边不知道时长就不否决
  return Math.abs(targetMs - candidateMs) <= 8000
}

const normalize = (text: string | undefined | null): string => String(text ?? '')
  .toLowerCase()
  .replace(/[\s'"，,、/&._\-（）()【】\[\]]/g, '')

/** 本机 MusicInfo → 稳定键（与房间一致的 `source:id`） */
export const stableKeyOfMusicInfo = (info: MusicInfoLike | null | undefined): string => {
  if (!info) return ''
  const id = String(info.meta?.songId ?? info.id ?? '')
  // 老数据里 id 可能是 `kw_123` 这种带前缀的，剥掉
  const bare = info.source && id.startsWith(`${info.source}_`) ? id.slice(info.source.length + 1) : id
  return info.source ? `${info.source}:${bare}` : bare
}

/** 歌名/歌手是否算同一首（版本差异如 remix/live 会落到第二档） */
export const isSameSong = (candidate: MusicInfoLike, target: TrackRef): boolean => {
  const nameEqual = normalize(candidate.name) === normalize(target.name)
  if (!nameEqual) return false
  if (!durationMatches(candidate, target)) return false
  const candidateSingers = normalize(candidate.singer).split(/[、,，/&]/).filter(Boolean)
  const targetSingers = normalize(target.singer).split(/[、,，/&]/).filter(Boolean)
  if (!targetSingers.length) return true
  return targetSingers.some(singer => candidateSingers.some(item => item.includes(singer) || singer.includes(item)))
}

/**
 * 从一组本机曲目里挑最像房间曲目的那首：
 * 稳定键命中优先级最高，其次同名同歌手，最后只同名。
 */
export const pickBestTrack = <T extends MusicInfoLike>(items: T[], target: TrackRef): T | null => {
  if (!items.length) return null
  const exact = items.find(item => stableKeyOfMusicInfo(item) === target.stableKey)
  if (exact) return exact
  const sameSongWithDuration = items.find(item => isSameSong(item, target) && durationMatches(item, target))
  if (sameSongWithDuration) return sameSongWithDuration
  const sameSong = items.find(item => isSameSong(item, target))
  if (sameSong) return sameSong
  const sameName = items.find(item => normalize(item.name) === normalize(target.name))
  return sameName ?? null
}
