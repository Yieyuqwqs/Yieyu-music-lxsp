import searchMusicState, { type Source } from '@/store/search/music/state'
import searchMusicActions, { type SearchResult } from '@/store/search/music/action'
import musicSdk from '@/utils/musicSdk'
import { sourceEngine } from '@/core/source'
import { AllSourcesFailedError, toAttemptFailure, type AttemptFailure } from '@/utils/attemptErrors'

export const setSource: typeof searchMusicActions['setSource'] = (source) => {
  searchMusicActions.setSource(source)
}
export const setSearchText: typeof searchMusicActions['setSearchText'] = (text) => {
  searchMusicActions.setSearchText(text)
}
export const setListInfo: typeof searchMusicActions.setListInfo = (result, id, page) => {
  return searchMusicActions.setListInfo(result, id, page)
}

export const clearListInfo: typeof searchMusicActions.clearListInfo = (source) => {
  searchMusicActions.clearListInfo(source)
}


/**
 * 搜索统一入口：引擎在就查 LXSP（多源由服务端聚合），
 * 引擎不在就退回内置实现。返回的仍是旧 SearchResult 形状。
 */
const searchBySource = (source: LX.Source, text: string, page: number, limit: number): Promise<SearchResult> => {
  // 只有「端点真的提供搜索」时才走引擎；API 模式 / 插件只给直链，没有搜索能力，
  // 这种情况必须回落到内置实现，否则界面会变成一片「到底啦」。
  if (sourceEngine.isInited && sourceEngine.hasSearchProvider(source)) {
    return sourceEngine.search(source, text, page, limit)
      .then(result => result as unknown as SearchResult)
      .catch((error) => {
        console.warn(`[search] 端点搜索失败，回落内置：${source} ${(error as Error).message}`)
        return fallbackSearch(source, text, page, limit)
      })
  }
  return fallbackSearch(source, text, page, limit)
}

const fallbackSearch = (source: LX.Source, text: string, page: number, limit: number): Promise<SearchResult> => (
  (musicSdk[source]?.musicSearch?.search(text, page, limit) as Promise<SearchResult>) ??
  Promise.reject(new Error('source not found: ' + source))
)

export const search = async(text: string, page: number, sourceId: Source): Promise<LX.Music.MusicInfoOnline[]> => {
  const listInfo = searchMusicState.listInfos[sourceId]!
  if (!text) return []
  const key = `${page}__${text}`
  if (sourceId == 'all') {
    listInfo.key = key
    const task: Array<Promise<SearchResult>> = []
    const failures: AttemptFailure[] = []
    let okCount = 0
    for (const source of searchMusicState.sources) {
      if (source == 'all') continue
      task.push(searchBySource(source, text, page, searchMusicState.listInfos.all.limit).then((result) => {
        okCount += 1
        return result
      }, (error: any) => {
        // 单个源失败不该毁掉整页结果；但"全部失败"必须说出来，不许装成"没有歌"
        failures.push(toAttemptFailure(source, error))
        return {
          allPage: 1,
          limit: 30,
          list: [],
          source,
          total: 0,
        } as SearchResult
      }))
    }
    return Promise.all(task).then((results: SearchResult[]) => {
      if (key != listInfo.key) return []
      if (okCount === 0 && failures.length > 0 && failures.length === task.length) {
        throw new AllSourcesFailedError(global.i18n.t('search_all_failed'), failures)
      }
      setSearchText(text)
      setSource(sourceId)
      return setListInfo(results, page, text)
    })
  } else {
    if (listInfo?.key == key && listInfo?.list.length) return listInfo?.list
    listInfo.key = key
    return searchBySource(sourceId, text, page, listInfo.limit).then((data) => {
      if (key != listInfo.key) return []
      return setListInfo(data, page, text)
    }).catch((err: any) => {
      if (listInfo.list.length && page == 1) clearListInfo(sourceId)
      throw err
    })
  }
}

