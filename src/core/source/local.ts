/**
 * 内置源适配器：把 App 里已有的 musicSdk 模块包装成 Provider。
 *
 * 它存在的意义不是「保留旧世界」，而是「兜底」：
 * 当 LXSP 端点全部不可用时，搜索/歌词/封面仍然能靠内置实现工作。
 * 注意：本 fork 的内置 getMusicUrl 早已被抽空（走 apis()），
 * 因此内置 Provider 不声明 url 能力 —— 直链只能由 LXSP 端点提供。
 */
import { LxspError } from './errors'
import { sortQualitiesDesc } from './quality'
import type {
  LyricResult,
  ProviderMeta,
  RequestContext,
  SearchQuery,
  SearchResultData,
  SourceProvider,
  TrackQuery,
  UrlQuery,
  UrlResult,
} from './types'

/** 各内置音源历史上支持的音质（保守声明，宁少不多） */
const LEGACY_QUALITIES: Partial<Record<LX.Source, LX.Lxsp.Quality[]>> = {
  kw: ['320k', '128k'],
  kg: ['flac24bit', 'flac', '320k', '128k'],
  tx: ['flac24bit', 'flac', '320k', '128k'],
  wy: ['flac24bit', 'flac', '320k', '128k'],
  mg: ['flac24bit', 'flac', '320k', '128k'],
}

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

export const createLegacyProvider = (source: LX.Source, priority: number, sdkInput: unknown): SourceProvider | null => {
  const sdk = sdkInput as AnyRecord | undefined
  if (!sdk || typeof sdk !== 'object') return null

  const capabilities: LX.Lxsp.Capability[] = []
  if (typeof sdk.musicSearch?.search === 'function') capabilities.push('search')
  if (typeof sdk.getLyric === 'function') capabilities.push('lyric')
  if (typeof sdk.getPic === 'function') capabilities.push('pic')

  const meta: ProviderMeta = {
    id: `legacy:${source}`,
    providerId: 'builtin',
    name: `${source.toUpperCase()}（内置）`,
    version: '1',
    kind: 'legacy',
    source,
    priority,
    qualities: sortQualitiesDesc(LEGACY_QUALITIES[source] ?? ['128k']),
    capabilities,
  }

  const provider: SourceProvider = {
    meta,
    supports: capability => capabilities.includes(capability),
    // 内置模块的 getMusicUrl 会回调 apis()，在这里调用会形成环；直链必须由 LXSP 端点提供
    resolveUrl: async(_query: UrlQuery): Promise<UrlResult> => {
      throw new LxspError('unsupported', `builtin source "${source}" cannot resolve url (use LXSP endpoint)`, { source })
    },
    lyric: async(query: TrackQuery, _ctx: RequestContext): Promise<LyricResult> => {
      if (typeof sdk.getLyric !== 'function') throw new LxspError('unsupported', 'builtin lyric unavailable', { source })
      const result = await unwrap(sdk.getLyric({ ...query, songmid: query.id, hash: query.id, copyrightId: query.id }))
      if (!result || typeof result.lyric !== 'string') throw new LxspError('bad_response', 'builtin lyric invalid', { source })
      return {
        lrc: result.lyric,
        tlrc: result.tlyric ?? null,
        rlrc: result.rlyric ?? null,
        lxlrc: result.lxlyric ?? null,
        format: 'lrc',
      }
    },
    pic: async(query: TrackQuery, _ctx: RequestContext): Promise<string> => {
      if (typeof sdk.getPic !== 'function') throw new LxspError('unsupported', 'builtin pic unavailable', { source })
      const url = await unwrap(sdk.getPic({ ...query, songmid: query.id, hash: query.id, copyrightId: query.id }))
      if (typeof url !== 'string' || !url) throw new LxspError('bad_response', 'builtin pic invalid', { source })
      return url
    },
    search: async(query: SearchQuery, _ctx: RequestContext): Promise<SearchResultData> => {
      if (typeof sdk.musicSearch?.search !== 'function') throw new LxspError('unsupported', 'builtin search unavailable', { source })
      const result = await unwrap(sdk.musicSearch.search(query.text, query.page, query.limit))
      const list = Array.isArray(result?.list) ? result.list : []
      return {
        items: list.map((item: AnyRecord) => ({
          id: extractTrackId(item),
          name: typeof item.name === 'string' ? item.name : '',
          singer: typeof item.singer === 'string' ? item.singer : '',
          album: typeof item.albumName === 'string' ? item.albumName : undefined,
          durationMs: intervalToMs(item.interval) ?? null,
          coverUrl: typeof item.img === 'string' ? item.img : null,
        })).filter((item: LX.Lxsp.Track) => item.id && item.name),
        page: query.page,
        limit: query.limit,
        total: typeof result?.total === 'number' ? result.total : null,
        hasMore: typeof result?.allPage === 'number' ? query.page < result.allPage : false,
      }
    },
  }

  return provider
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
