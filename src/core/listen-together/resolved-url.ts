/**
 * 直链登记表
 *
 * 一起听要把「房主正在播的那条直链」发给成员（Teleparty 这类产品就是这么干的：
 * 每人自己播，但共享同一个播放目标）。可 react-native-track-player 的
 * getActiveTrack() 在某些情况下拿不到 url，所以在**解析成功的那一刻**就记下来，
 * 这里就是那个记录点，别再去播放器内部猜。
 */
interface Entry {
  url: string
  at: number
  durationMs: number
}

const MAX = 8
const TTL_MS = 6 * 60 * 60 * 1000
const entries = new Map<string, Entry>()
let lastKey: string | null = null

const keyOf = (info: { id?: string | null, source?: string } | null | undefined): string => {
  if (!info) return ''
  return `${info.source ?? ''}:${info.id ?? ''}`
}

export const rememberResolvedUrl = (musicInfo: { id?: string | null, source?: string, interval?: string | null } | null | undefined, url: string): void => {
  if (!musicInfo || !url || !/^https?:/i.test(url)) return
  const key = keyOf(musicInfo)
  if (!key) return
  const now = Date.now()
  entries.set(key, { url, at: now, durationMs: parseInterval(musicInfo.interval) })
  lastKey = key
  if (entries.size > MAX) {
    for (const [k, v] of entries) {
      if (now - v.at > TTL_MS || entries.size > MAX) entries.delete(k)
    }
  }
}

export const getResolvedUrl = (source?: string, id?: string | null): string | null => {
  const entry = entries.get(`${source ?? ''}:${id ?? ''}`)
  if (!entry) return null
  if (Date.now() - entry.at > TTL_MS) return null
  return entry.url
}

/** 最近一条解析成功的直链（房主推送当前歌曲时兜底用） */
export const getLastResolvedUrl = (): string | null => {
  if (!lastKey) return null
  const entry = entries.get(lastKey)
  if (!entry || Date.now() - entry.at > TTL_MS) return null
  return entry.url
}

export const clearResolvedUrls = (): void => {
  entries.clear()
  lastKey = null
}

const parseInterval = (interval?: string | null): number => {
  if (!interval) return 0
  const parts = interval.split(':').map(part => Number.parseInt(part, 10)).filter(part => Number.isFinite(part))
  if (!parts.length) return 0
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return seconds * 1000
}
