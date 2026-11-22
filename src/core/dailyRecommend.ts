import { LIST_IDS } from '@/config/constant'
import { createUserList, addListMusics, getListMusics, removeListMusics } from '@/core/list'
import { getHistorySync } from '@/core/history'
import listState from '@/store/list/state'

const MAX_SONGS = 30

const shuffle = (arr: any[]): any[] => {
  const list: any[] = [...arr]
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

const getDateName = () => {
  const date = new Date()
  return `每日推荐 ${date.getMonth() + 1}/${date.getDate()}`
}

/**
 * 根据播放历史 + 收藏生成本地「每日推荐」歌单
 */
export const generateDailyRecommend = async(): Promise<number> => {
  const map = new Map<string, LX.Music.MusicInfo>()
  for (const item of getHistorySync()) {
    const musicInfo = item.musicInfo as LX.Music.MusicInfo
    if (!musicInfo?.id) continue
    if (map.has(musicInfo.id)) continue
    map.set(musicInfo.id, musicInfo)
  }
  let songs = [...map.values()]
  if (songs.length < 5) {
    const loveList = await getListMusics(LIST_IDS.LOVE).catch(() => [])
    for (const musicInfo of loveList) {
      if (map.has(musicInfo.id)) continue
      map.set(musicInfo.id, musicInfo)
      songs.push(musicInfo)
    }
  }
  if (!songs.length) throw new Error('no music')

  const list = shuffle(songs).slice(0, MAX_SONGS)
  const name = getDateName()
  let target = listState.allList.find(item => item.id != LIST_IDS.DEFAULT && item.id != LIST_IDS.LOVE && item.name == name)
  if (!target) {
    const id = `daily_${Date.now()}`
    const now = Date.now()
    await createUserList(0, [{ id, name, locationUpdateTime: now }])
    target = { id, name, locationUpdateTime: now } as any
  }
  // 清空旧内容后写入
  const oldMusics = await getListMusics(target.id).catch(() => [])
  if (oldMusics.length) await removeListMusics(target.id, oldMusics.map(item => item.id))
  await addListMusics(target.id, list, 'bottom')
  return list.length
}
