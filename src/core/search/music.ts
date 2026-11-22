import searchMusicState, { type Source } from '@/store/search/music/state'
import searchMusicActions, { type SearchResult } from '@/store/search/music/action'
import musicSdk from '@/utils/musicSdk'
import { sourceEngine } from '@/core/source'

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
  if (sourceEngine.isInited) {
    return sourceEngine.search(source, text, page, limit)
      .then(result => result as unknown as SearchResult)
      .catch((error) => {
        throw error
      })
  }
  return (musicSdk[source]?.musicSearch.search(text, page, limit) as Promise<SearchResult>) ??
    Promise.reject(new Error('source not found: ' + source))
}

export const search = async(text: string, page: number, sourceId: Source): Promise<LX.Music.MusicInfoOnline[]> => {
  const listInfo = searchMusicState.listInfos[sourceId]!
  if (!text) return []
  const key = `${page}__${text}`
  if (sourceId == 'all') {
    listInfo.key = key
    let task = []
    for (const source of searchMusicState.sources) {
      if (source == 'all') continue
      task.push(searchBySource(source, text, page, searchMusicState.listInfos.all.limit).catch((error: any) => {
        console.log(error)
        return {
          allPage: 1,
          limit: 30,
          list: [],
          source,
          total: 0,
        }
      }))
    }
    return Promise.all(task).then((results: SearchResult[]) => {
      if (key != listInfo.key) return []
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

