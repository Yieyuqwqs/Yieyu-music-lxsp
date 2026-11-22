import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { TouchableOpacity, View } from 'react-native'

import { Icon } from '@/components/common/Icon'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { usePlayMusicInfo } from '@/store/player/hook'
import { useDownloadTask } from '@/store/downloadList/hook'
import { addTasks, pauseTask, resumeTask, retryTask } from '@/core/download'
import { getTaskId } from '@/core/download/utils'
import QualityPicker, { type QualityPickerType } from './QualityPicker'
import { createStyle, toast } from '@/utils/tools'
import { scaleSizeH } from '@/utils/pixelRatio'
import { HEADER_HEIGHT as _HEADER_HEIGHT } from '@/config/constant'

const HEADER_HEIGHT = scaleSizeH(_HEADER_HEIGHT)

/**
 * 播放页的下载按钮：点击可选择音质并下载，下载中可暂停/继续
 */
export default memo(() => {
  const theme = useTheme()
  const t = useI18n()
  const pickerRef = useRef<QualityPickerType>(null)
  const playMusicInfo = usePlayMusicInfo()
  const musicInfo = playMusicInfo.musicInfo

  const isListItem = !!musicInfo && 'progress' in musicInfo
  const isOnlineMusic = !!musicInfo && !isListItem && 'source' in musicInfo && musicInfo.source != 'local'
  const taskId = musicInfo && !isListItem ? getTaskId(musicInfo as LX.Music.MusicInfo) : ''
  const task = useDownloadTask(taskId)

  const handlePress = useCallback(() => {
    if (!isOnlineMusic) return
    const target = musicInfo as LX.Music.MusicInfoOnline
    switch (task?.status) {
      case 'completed':
        toast(t('download_status_completed'))
        return
      case 'run':
      case 'waiting':
        pauseTask(task.id)
        return
      case 'error':
        retryTask(task.id)
        return
      case 'pause':
        resumeTask(task.id)
        return
      default:
        pickerRef.current?.show(target, (quality) => {
          void addTasks([target], quality).then(({ added }) => {
            if (added) toast(t('download_task_added_tip', { num: added }))
          }).catch(() => {})
        })
    }
  }, [isOnlineMusic, musicInfo, task, t])

  const { iconName, color } = useMemo(() => {
    switch (task?.status) {
      case 'completed':
        return { iconName: 'checkbox-marked', color: theme['c-primary'] }
      case 'run':
      case 'waiting':
        return { iconName: 'download-2', color: theme['c-primary'] }
      case 'error':
        return { iconName: 'download-2', color: '#ff6b6b' }
      default:
        return { iconName: 'download-2', color: '#ffffff' }
    }
  }, [task?.status, theme])

  useEffect(() => {
    // 保证钩子数量稳定，无需额外副作用
  }, [])

  if (!isOnlineMusic) return null

  const isRunning = task?.status == 'run' || task?.status == 'waiting'

  return (
    <>
      <TouchableOpacity onPress={handlePress} style={styles.button}>
        <View style={styles.content}>
          <Icon name={iconName} color={color} size={18} />
          {
            isRunning && task
              ? <Text size={9} color={color} style={styles.progress}>{`${task.progress}%`}</Text>
              : null
          }
        </View>
      </TouchableOpacity>
      <QualityPicker ref={pickerRef} />
    </>
  )
})

const styles = createStyle({
  button: {
    justifyContent: 'center',
    alignItems: 'center',
    height: '100%',
    flex: 0,
    minWidth: HEADER_HEIGHT,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  progress: {
    marginLeft: 1,
  },
})
