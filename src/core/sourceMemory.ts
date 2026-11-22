import { getSourceMemory, saveSourceMemory } from '@/utils/data'

const MAX_ITEMS = 800
let memory: Record<string, string> = {}
let saveTimer: ReturnType<typeof setTimeout> | null = null

const keyOf = (name: string, singer: string) => `${name}__${singer}`

const saveThrottle = () => {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void saveSourceMemory(memory).catch(() => {})
  }, 3000)
}

export const init = async() => {
  memory = await getSourceMemory().catch(() => ({}))
}

export const rememberSource = (musicInfo: { name: string, singer?: string, source: LX.Source }) => {
  if (!musicInfo?.name) return
  const key = keyOf(musicInfo.name, musicInfo.singer ?? '')
  if (memory[key] == musicInfo.source) return
  const keys = Object.keys(memory)
  if (keys.length >= MAX_ITEMS) delete memory[keys[0]]
  memory[key] = musicInfo.source
  saveThrottle()
}

export const getRememberedSource = (name: string, singer: string) => memory[keyOf(name, singer ?? '')] ?? ''

/**
 * 把记忆中播放成功的音源排到前面
 */
export const preferRememberedSource = <T extends { name: string, singer: string, source: LX.OnlineSource }>(list: T[]): T[] => {
  if (list.length < 2) return list
  const remembered = getRememberedSource(list[0].name, list[0].singer)
  if (!remembered) return list
  return [...list].sort((a, b) => {
    if (a.source == remembered) return -1
    if (b.source == remembered) return 1
    return 0
  })
}
