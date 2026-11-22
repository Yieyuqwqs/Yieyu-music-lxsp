import { useEffect, useState } from 'react'

import { getPlayHistory, savePlayHistory } from '@/utils/data'

const MAX_HISTORY = 100

let history: LX.PlayHistoryItem[] = []
const listeners = new Set<(list: LX.PlayHistoryItem[]) => void>()

const emit = () => {
  const list = [...history]
  for (const listener of listeners) listener(list)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
const saveThrottle = () => {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void savePlayHistory(history).catch(() => {})
  }, 3000)
}

const handlePlayMusicInfoChanged = (info: LX.Player.PlayMusicInfo) => {
  const musicInfo = info?.musicInfo
  if (!musicInfo?.id) return
  const last = history[0]
  if (last && last.musicInfo.id == musicInfo.id && last.listId == (info.listId ?? '') && Date.now() - last.time < 5000) return
  history.unshift({
    time: Date.now(),
    listId: info.listId ?? '',
    musicInfo,
  })
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY
  saveThrottle()
  emit()
}

export const init = async() => {
  history = await getPlayHistory().catch(() => [])
  emit()
  global.state_event.on('playMusicInfoChanged', handlePlayMusicInfoChanged)
}

export const getHistorySync = () => history

export const clearHistory = async() => {
  history = []
  emit()
  await savePlayHistory([]).catch(() => {})
}

export const removeHistory = async(index: number) => {
  if (index < 0 || index >= history.length) return
  history.splice(index, 1)
  emit()
  await savePlayHistory(history).catch(() => {})
}

export const useHistory = () => {
  const [list, setList] = useState<LX.PlayHistoryItem[]>(() => [...history])

  useEffect(() => {
    listeners.add(setList)
    setList([...history])
    return () => {
      listeners.delete(setList)
    }
  }, [])

  return list
}
