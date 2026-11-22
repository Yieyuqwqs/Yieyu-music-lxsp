/**
 * 当前正在播放的 CUE 切片窗口。
 * 播放层所有"绝对位置 ↔ 显示位置"的换算都从这里取，避免到处翻 meta 类型。
 * 只对 meta.cue 存在的曲目生效，普通歌曲永远是 null。
 */
export interface CueWindow {
  id: string
  start: number
  end: number
}

let current: CueWindow | null = null

const readCue = (musicInfo: LX.Music.MusicInfo | null | undefined): { start: number, end: number } | null => {
  try {
    if (musicInfo == null) return null
    const meta = musicInfo.meta as LX.Music.MusicInfoMeta_local & { cue?: { start: number, end: number } }
    const cue = meta.cue
    if (cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start) {
      return { start: cue.start, end: cue.end }
    }
  } catch {}
  return null
}

/** 切歌时同步窗口；非 CUE 曲目会把窗口清空 */
export const setCueWindow = (musicInfo: LX.Music.MusicInfo | null | undefined) => {
  const cue = readCue(musicInfo)
  current = cue != null && musicInfo != null ? { id: musicInfo.id, start: cue.start, end: cue.end } : null
}

export const getCueWindow = (): CueWindow | null => current

export const cueStart = (): number => current == null ? 0 : current.start

export const cueDuration = (): number => current == null ? 0 : current.end - current.start
