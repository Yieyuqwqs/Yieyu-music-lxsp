import { memo, useMemo } from 'react'
import { View } from 'react-native'

import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { usePlayMusicInfo } from '@/store/player/hook'
import { useDownloadTask } from '@/store/downloadList/hook'
import { useSettingValue } from '@/store/setting/hook'
import { getQualityLabelKey } from '@/config/quality'
import { getPlayQuality } from '@/core/music/utils'
import { getTaskId } from '@/core/download/utils'
import { createStyle } from '@/utils/tools'

/**
 * 播放页顶部的“当前播放音质”信息条
 */
export default memo(() => {
  const theme = useTheme()
  const t = useI18n()
  const playMusicInfo = usePlayMusicInfo()
  const musicInfo = playMusicInfo.musicInfo
  const playQuality = useSettingValue('player.playQuality')

  const isListItem = !!musicInfo && 'progress' in musicInfo
  const isOnline = !!musicInfo && !isListItem && 'source' in musicInfo && musicInfo.source != 'local'
  const taskId = musicInfo && !isListItem ? getTaskId(musicInfo as LX.Music.MusicInfo) : ''
  const task = useDownloadTask(taskId)

  const qualityLabel = useMemo(() => {
    if (!musicInfo?.id) return ''
    if (task?.metadata?.quality) return t(getQualityLabelKey(task.metadata.quality as LX.QualitySetting) as never)
    if (isListItem) return ''
    if (isOnline) return t(getQualityLabelKey(getPlayQuality(playQuality, musicInfo as LX.Music.MusicInfoOnline)) as never)
    const local = musicInfo as LX.Music.MusicInfoLocal
    return (local.meta?.ext ?? '').toUpperCase() || 'LOCAL'
  }, [musicInfo, task, isListItem, isOnline, playQuality, t])

  const statusText = useMemo(() => {
    if (!task) return ''
    switch (task.status) {
      case 'completed':
        return t('quality_bar_downloaded')
      case 'run':
        return `${task.progress}%`
      default:
        return task.statusText
    }
  }, [task, t])

  if (!musicInfo?.id || !qualityLabel) return null

  return (
    <View style={styles.container}>
      <View style={{ ...styles.pill, backgroundColor: 'rgba(255,255,255,0.12)' }}>
        <Text size={10} color={'rgba(255,255,255,0.7)'}>
          {statusText ? `${qualityLabel} · ${statusText}` : qualityLabel}
        </Text>
      </View>
    </View>
  )
})

const styles = createStyle({
  container: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 4,
    paddingBottom: 4,
  },
  pill: {
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 2,
    paddingBottom: 2,
    borderRadius: 10,
  },
})
