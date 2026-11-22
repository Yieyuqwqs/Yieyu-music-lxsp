/**
 * CUE 分轨解析（极客功能二）
 * 覆盖常见写法：FILE / TRACK nn AUDIO / INDEX 00|01 / TITLE / PERFORMER / REM DATE|GENRE，
 * 时间码遵循 Red Book：mm:ss:ff，75 帧 = 1 秒。
 */
export interface CueRawTrack {
  no: number
  title: string
  performer: string
  /** INDEX 01（真正开唱的位置，秒） */
  start: number
  /** INDEX 00（pregap）存在时用它当作上一曲的终点 */
  pregap: number | null
}

export interface CueSheet {
  /** FILE 里声明的音频文件名（可能带路径） */
  file: string
  title: string
  performer: string
  genre: string
  date: string
  tracks: CueRawTrack[]
}

export interface CueTrackRange extends CueRawTrack {
  /** 切片终点（秒，绝对） */
  end: number
}

const unquote = (value: string): string => {
  const text = value.trim()
  const quoted = /^"([\s\S]*)"$/.exec(text)
  return quoted ? quoted[1] : text
}

/** mm:ss:ff → 秒；非法返回 -1 */
export const parseCueTime = (value: string): number => {
  const match = /^(\d{1,3}):([0-5]?\d):(\d{1,2})$/.exec(value.trim())
  if (!match) return -1
  const minutes = Number(match[1])
  const seconds = Number(match[2])
  const frames = Number(match[3])
  if (frames > 74) return -1
  return minutes * 60 + seconds + frames / 75
}

export const parseCueText = (text: string): CueSheet[] => {
  const sheets: CueSheet[] = []
  let sheet: CueSheet | null = null
  let track: CueRawTrack | null = null
  let index00: number | null = null
  let pendingTrackNo = 0
  // 标准 CUE 的专辑级 TITLE/PERFORMER/REM 写在 FILE 之前，先缓存，建块时带进去
  const albumInfo = { title: '', performer: '', genre: '', date: '' }

  const finishTrack = () => {
    if (track == null) return
    if (track.start < 0) {
      // 只有 INDEX 00 没有 INDEX 01 的畸形文件：用 pregap 兜底
      track.start = track.pregap ?? 0
    }
    if (track.title === '') track.title = sheet != null && sheet.tracks.length === 0 && sheet.title !== '' ? sheet.title : ''
    sheet?.tracks.push(track)
    track = null
    index00 = null
  }

  const finishSheet = () => {
    finishTrack()
    if (sheet != null && sheet.tracks.length) sheets.push(sheet)
    sheet = null
  }

  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('//')) continue
    const match = /^([A-Za-z]+)\s*([\s\S]*)$/.exec(line)
    if (match == null) continue
    const keyword = match[1].toUpperCase()
    const rest = match[2].trim()
    switch (keyword) {
      case 'FILE': {
        finishSheet()
        const quoted = /^"([\s\S]*)"\s*(.*)$/.exec(rest)
        const file = quoted != null ? quoted[1] : rest.replace(/\s+(WAVE|MP3|AIFF|BINARY)\s*$/i, '')
        sheet = { file, title: albumInfo.title, performer: albumInfo.performer, genre: albumInfo.genre, date: albumInfo.date, tracks: [] }
        break
      }
      case 'TRACK': {
        if (sheet == null) {
          sheet = { file: '', title: albumInfo.title, performer: albumInfo.performer, genre: albumInfo.genre, date: albumInfo.date, tracks: [] }
        }
        finishTrack()
        pendingTrackNo = parseInt(rest, 10)
        if (!Number.isFinite(pendingTrackNo)) pendingTrackNo = (sheet.tracks.length + 1)
        track = { no: pendingTrackNo, title: '', performer: '', start: -1, pregap: null }
        break
      }
      case 'INDEX': {
        if (track == null) break
        const indexMatch = /^(\d{1,2})\s+(\S+)$/.exec(rest)
        if (indexMatch == null) break
        const time = parseCueTime(indexMatch[2])
        if (time < 0) break
        if (indexMatch[1] === '00') {
          index00 = time
          track.pregap = time
        } else if (indexMatch[1] === '01') {
          track.start = time
        }
        break
      }
      case 'TITLE': {
        const value = unquote(rest)
        if (value === '') break
        if (track != null) {
          track.title = value
          break
        }
        albumInfo.title = value
        if (sheet != null) sheet.title = value
        break
      }
      case 'PERFORMER': {
        const value = unquote(rest)
        if (value === '') break
        if (track != null) {
          track.performer = value
          break
        }
        albumInfo.performer = value
        if (sheet != null) sheet.performer = value
        break
      }
      case 'REM': {
        const rem = /^([A-Za-z]+)\s*([\s\S]*)$/.exec(rest)
        if (rem == null) break
        const key = rem[1].toUpperCase()
        const value = unquote(rem[2])
        if (key === 'DATE') {
          albumInfo.date = value
          if (sheet != null) sheet.date = value
        } else if (key === 'GENRE') {
          albumInfo.genre = value
          if (sheet != null) sheet.genre = value
        } else if (key === 'ALBUM' && albumInfo.title === '') {
          albumInfo.title = value
          if (sheet != null && sheet.title === '') sheet.title = value
        }
        break
      }
      default:
        break
    }
  }
  finishSheet()
  return sheets
}

/**
 * 把解析结果换算成可播放区间：
 * 终点 = 下一曲的 INDEX 00（有 pregap 就把它算进当前曲）或 INDEX 01；最后一曲用整轨时长。
 */
export const resolveCueRanges = (sheet: CueSheet, duration: number): CueTrackRange[] => {
  const tracks = [...sheet.tracks].sort((a, b) => a.start - b.start)
  const total = duration > 0 ? duration : (tracks.length ? tracks[tracks.length - 1].start : 0)
  return tracks.map((track, index) => {
    const next = tracks[index + 1]
    let end = next != null ? (next.pregap != null && next.pregap > track.start ? next.pregap : next.start) : total
    if (!(end > track.start)) end = total > track.start ? total : track.start
    return { ...track, end }
  }).filter(track => track.end > track.start)
}
