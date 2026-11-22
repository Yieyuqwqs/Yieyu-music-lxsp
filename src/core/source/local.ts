/**
 * 旧数据模型 ↔ LXSP 曲目的纯转换工具（不含任何音源实现）。
 * 音源只有一种：LXSP v2 端点；这里只负责把 Track 变成 App 内部的旧形状。
 */

/** 旧数据模型里 id 字段五花八门，这里收敛成唯一入口 */
const ID_KEYS = ['songmid', 'hash', 'copyrightId', 'contentId', 'musicId', 'songId', 'trackId', 'rid', 'mid', 'id'] as const

export const extractTrackId = (info: unknown): string => {
  if (typeof info === 'string') return info
  if (!info || typeof info !== 'object') return ''
  const record = info as Record<string, unknown>
  for (const key of ID_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

const intervalToMs = (interval: unknown): number | undefined => {
  if (typeof interval !== 'string' || !interval) return undefined
  const parts = interval.split(':').map(part => Number.parseInt(part, 10)).filter(part => Number.isFinite(part))
  if (!parts.length) return undefined
  let total = 0
  for (const part of parts) total = total * 60 + part
  return total * 1000
}

export const toLegacyQuery = (info: Record<string, unknown>): { id: string, name?: string, singer?: string, album?: string, duration?: number } => ({
  id: extractTrackId(info),
  name: typeof info.name === 'string' ? info.name : undefined,
  singer: typeof info.singer === 'string' ? info.singer : undefined,
  album: typeof info.albumName === 'string' ? info.albumName : undefined,
  duration: intervalToMs(info.interval),
})

type AnyRecord = Record<string, any>

/** 内置模块历史返回形状不统一：有的直接给 Promise，有的给 {promise, cancelFn}，这里统一拆包 */
const unwrap = async(value: unknown): Promise<any> => {
  const boxed = value as { promise?: unknown } | null
  const inner = boxed && typeof boxed === 'object' && 'promise' in boxed ? boxed.promise : value
  return await inner
}

/** 毫秒 → mm:ss（LX 旧数据模型用字符串时长） */
export const msToInterval = (ms: number | null | undefined): string => {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "00:00"
  const total = Math.round(ms / 1000)
  const minute = Math.floor(total / 60)
  const second = total % 60
  return `${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`
}

/**
 * LXSP Track → 旧 MusicInfoOnline 形状（toNewMusicInfo 的输入）。
 * 因为 App 里搜索/列表/播放队列全部基于旧形状，
 * 这一层做「一次转换」，好过在几十个界面里各写各的。
 */
export const toLegacyMusicItem = (
  source: LX.Source,
  track: LX.Lxsp.Track,
  fallbackQualities: LX.Lxsp.Quality[] = ["128k"],
): Record<string, unknown> => {
  const qualityMap: Record<string, LX.Lxsp.QualityDetail> = { ...(track.qualities ?? {}) }
  if (!Object.keys(qualityMap).length) {
    for (const quality of fallbackQualities) qualityMap[quality] = {}
  }
  const types = Object.keys(qualityMap).map(type => ({ type, size: qualityMap[type]?.size ?? null }))
  const id = String(track.id)
  return {
    // 旧模型里不同平台用不同字段名找 id，全部填同一个值即可
    songmid: id,
    songId: id,
    hash: id,
    copyrightId: id,
    contentId: id,
    musicId: id,
    mid: id,
    name: track.name,
    singer: track.singer || "",
    albumName: track.album ?? "",
    interval: msToInterval(track.durationMs),
    img: track.coverUrl ?? null,
    source,
    types,
    _types: qualityMap,
    ...(track.extra ? { extra: track.extra } : {}),
  }
}
