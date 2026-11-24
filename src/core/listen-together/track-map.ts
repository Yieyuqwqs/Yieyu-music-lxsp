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
  meta?: { songId?: string } & Record<string, unknown>
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
  const sameSong = items.find(item => isSameSong(item, target))
  if (sameSong) return sameSong
  const sameName = items.find(item => normalize(item.name) === normalize(target.name))
  return sameName ?? null
}
