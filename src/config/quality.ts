export type QualityLevel = LX.Quality | 'atmos' | 'atmos_plus' | 'master'
export type QualitySetting = QualityLevel | 'auto'

/**
 * 音质档位（从高到低），共 7 档 + 自动 = 8 档
 * 母带 / 全景声 / 全景声+ 需要音源（自定义源）本身支持，否则会自动降级
 */
export const QUALITY_LEVELS: QualityLevel[] = ['master', 'atmos_plus', 'atmos', 'flac24bit', 'flac', '320k', '128k']

export const QUALITY_OPTIONS: Array<{ id: QualitySetting, labelKey: string }> = [
  { id: 'master', labelKey: 'quality_master' },
  { id: 'atmos_plus', labelKey: 'quality_atmos_plus' },
  { id: 'atmos', labelKey: 'quality_atmos' },
  { id: 'flac24bit', labelKey: 'quality_flac24bit' },
  { id: 'flac', labelKey: 'quality_flac' },
  { id: '320k', labelKey: 'quality_320k' },
  { id: '128k', labelKey: 'quality_128k' },
  { id: 'auto', labelKey: 'quality_auto' },
]

const QUALITY_LABEL_KEYS: Record<QualitySetting, string> = {
  master: 'quality_master',
  atmos_plus: 'quality_atmos_plus',
  atmos: 'quality_atmos',
  flac24bit: 'quality_flac24bit',
  flac: 'quality_flac',
  '320k': 'quality_320k',
  '192k': 'quality_192k',
  '128k': 'quality_128k',
  ape: 'quality_ape',
  wav: 'quality_wav',
  auto: 'quality_auto',
}

export const getQualityLabelKey = (quality: QualitySetting): string => QUALITY_LABEL_KEYS[quality] ?? 'quality_128k'

export type QualitySizeInfo = Partial<Record<string, { size: string | null }>>

/**
 * 获取该歌曲可用的音质列表（按优先级，从设置档位开始向下降级）
 */
export const getQualityCandidates = (setting: QualitySetting, musicInfo: LX.Music.MusicInfoOnline): QualityLevel[] => {
  const qualitys = musicInfo.meta?._qualitys as QualitySizeInfo | undefined
  const sourceQualityList: string[] | undefined = (global.lx?.qualityList as Record<string, string[]> | undefined)?.[musicInfo.source]
  let startIndex = 0
  if (setting != 'auto') {
    const index = QUALITY_LEVELS.indexOf(setting)
    startIndex = index < 0 ? 0 : index
  }
  const list: QualityLevel[] = []
  for (const quality of QUALITY_LEVELS.slice(startIndex)) {
    if (qualitys && qualitys[quality]) {
      if (sourceQualityList && !sourceQualityList.includes(quality)) continue
      list.push(quality)
    }
  }
  if (!list.length) {
    // 没有任何音质信息时退化到 128k
    list.push('128k')
  }
  return list
}

/**
 * 获取歌曲各音质的大小信息，用于音质选择弹窗展示
 */
export const getQualitySize = (musicInfo: LX.Music.MusicInfoOnline, quality: QualitySetting): string | null => {
  const qualitys = musicInfo.meta?._qualitys as QualitySizeInfo | undefined
  if (!qualitys) return null
  return qualitys[quality]?.size ?? null
}
