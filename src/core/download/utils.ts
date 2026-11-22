import { getQualityCandidates } from '@/config/quality'

const AUDIO_EXTS = ['mp3', 'flac', 'wav', 'ape', 'm4a', 'ogg', 'aac', 'wma', 'opus']

export const formatSize = (size: number): string => {
  if (!size || size < 0) return '0B'
  let num = size
  let unit = 'B'
  if (num >= 1024) {
    num = num / 1024
    unit = 'KB'
  }
  if (num >= 1024) {
    num = num / 1024
    unit = 'MB'
  }
  if (num >= 1024) {
    num = num / 1024
    unit = 'GB'
  }
  return `${num.toFixed(num >= 100 ? 0 : 1)}${unit}`
}

export const formatSpeed = (speed: number): string => {
  if (!speed || speed <= 0) return ''
  return `${formatSize(speed)}/s`
}

/**
 * 移除文件名中不能用的字符
 */
export const sanitizeFileName = (name: string): string => {
  const result = name
    .replace(/[/\\:*?"<>|\r\n\t]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F]/g, '')
    .trim()
    .replace(/[. ]+$/, '')
    .substring(0, 120)
  return result || 'music'
}

export const buildFileName = (musicInfo: LX.Music.MusicInfoOnline, ext: string, format: LX.AppSetting['download.fileName']): string => {
  const name = musicInfo.name?.trim() || '未知歌曲'
  const singer = musicInfo.singer?.trim() || '未知歌手'
  let fileName: string
  switch (format) {
    case '歌手 - 歌名':
      fileName = `${singer} - ${name}`
      break
    case '歌名':
      fileName = name
      break
    case '歌名 - 歌手':
    default:
      fileName = `${name} - ${singer}`
      break
  }
  return `${sanitizeFileName(fileName)}.${ext}`
}

const getExtByQuality = (quality: LX.Quality | undefined): string => {
  switch (quality) {
    case 'flac':
    case 'flac24bit':
      return 'flac'
    case 'ape':
      return 'ape'
    case 'wav':
      return 'wav'
    default:
      return 'mp3'
  }
}

/**
 * 从下载链接中获取文件扩展名，获取失败时使用音质对应的扩展名
 */
export const getExtFromUrl = (url: string | null | undefined, quality?: LX.Quality): string => {
  if (url) {
    try {
      const path = url.split('?')[0].split('#')[0]
      const result = /\.([a-zA-Z0-9]{2,5})$/.exec(path)
      const ext = result?.[1]?.toLowerCase()
      if (ext && AUDIO_EXTS.includes(ext)) return ext
    } catch {}
  }
  return getExtByQuality(quality)
}

/**
 * 根据设置获取下载时可尝试的音质列表（按优先级排序，自动降级）
 */
export const getDownloadQualityList = (musicInfo: LX.Music.MusicInfoOnline, quality: LX.QualitySetting): LX.QualityLevel[] => {
  return getQualityCandidates(quality, musicInfo)
}

export const getTaskId = (musicInfo: LX.Music.MusicInfo): string => `${musicInfo.source}__${musicInfo.id}`

export const checkTaskCompleted = (task: LX.Download.ListItem): boolean => task.status == 'completed' && !!task.metadata.filePath
