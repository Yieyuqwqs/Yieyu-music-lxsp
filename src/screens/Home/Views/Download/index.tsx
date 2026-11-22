import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, FlatList, TouchableOpacity, View } from 'react-native'

import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { clipboardWriteText, confirmDialog, createStyle, toast } from '@/utils/tools'
import { useDownloadList } from '@/store/downloadList/hook'
import downloadState from '@/store/downloadList/state'
import {
  clearCompletedTasks,
  pauseAllTasks,
  pauseTask,
  removeTasks,
  resumeTask,
  retryTask,
  startAllTasks,
} from '@/core/download'
import { formatSize } from '@/core/download/utils'
import { getQualityLabelKey } from '@/config/quality'
import { addTempPlayList } from '@/core/player/tempPlayList'
import { scaleSizeH } from '@/utils/pixelRatio'

const FILTER_ALL = 'all'
const FILTER_RUNNING = 'running'
const FILTER_DONE = 'done'
type Filter = typeof FILTER_ALL | typeof FILTER_RUNNING | typeof FILTER_DONE

const TaskItem = memo(({ task }: { task: LX.Download.ListItem }) => {
  const theme = useTheme()
  const t = useI18n()
  const musicInfo = task.metadata.musicInfo

  const isRun = task.status == 'run'
  const isCompleted = task.status == 'completed'
  const canResume = task.status == 'pause' || task.status == 'error'

  const statusText = useMemo(() => {
    switch (task.status) {
      case 'run':
        return `${t('download_status_run')}${task.speed ? `  ${task.speed}` : ''}${task.total ? `  ${formatSize(task.downloaded)} / ${formatSize(task.total)}` : ''}`
      case 'completed':
        return `${t('download_status_completed')}${task.total ? `  ${formatSize(task.total)}` : ''}`
      case 'pause':
        return t('download_status_pause')
      case 'error':
        return task.statusText || t('download_status_error')
      default:
        return t('download_status_waiting')
    }
  }, [task.status, task.speed, task.total, task.downloaded, task.statusText, t])

  const handleResume = useCallback(() => {
    if (task.status == 'error') retryTask(task.id)
    else resumeTask(task.id)
  }, [task.id, task.status])

  const handleDelete = useCallback(() => {
    void confirmDialog({
      message: t('download_remove_tip', { name: musicInfo.name }),
      confirmButtonText: t('download_remove_button'),
    }).then(isRemove => {
      if (!isRemove) return
      void removeTasks([task.id])
    })
  }, [task.id, musicInfo.name, t])

  const progress = isCompleted ? 100 : Math.max(Math.min(task.progress || 0, 100), 0)
  const localPicPath = isCompleted && task.metadata.filePath
    ? `file://${task.metadata.filePath.replace(/\.[^.]+$/, '.jpg')}`
    : null
  const picUrl = musicInfo.meta?.picUrl || localPicPath
  const widthAnim = useRef(new Animated.Value(progress)).current
  const qualityLabel = t(getQualityLabelKey((task.metadata.quality ?? '128k') as LX.QualitySetting) as never)

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: progress,
      duration: 400,
      useNativeDriver: false,
    }).start()
  }, [progress, widthAnim])

  const handleLongPress = useCallback(() => {
    if (task.status != 'completed' || !task.metadata.filePath) return
    clipboardWriteText(task.metadata.filePath)
    toast(t('download_page_copy_path_tip'))
  }, [task.status, task.metadata.filePath, t])

  const handlePressItem = useCallback(() => {
    if (task.status != 'completed') return
    addTempPlayList([{ listId: '', musicInfo }])
  }, [task.status, musicInfo])

  return (
    <View style={{ ...styles.item, backgroundColor: theme['c-primary-alpha-100'] }}>
      <View style={styles.picContent}>
        <Image url={picUrl} style={styles.pic} resizeMode="cover" />
        {
          isCompleted
            ? <View style={{ ...styles.picBadge, backgroundColor: theme['c-primary'] }}>
                <Icon name="checkbox-marked" size={10} color={theme['c-primary-font']} />
              </View>
            : null
        }
      </View>
      <TouchableOpacity style={styles.itemContent} activeOpacity={0.8} onPress={handlePressItem} onLongPress={handleLongPress}>
        <Text numberOfLines={1} size={15}>{musicInfo.name}</Text>
        <Text numberOfLines={1} size={12} color={theme['c-font-label']} style={styles.itemSinger}>{musicInfo.singer}</Text>
        <View style={styles.progressRow}>
          <View style={{ ...styles.progressBarBg, backgroundColor: theme['c-primary-alpha-200'] }}>
            <Animated.View style={{ ...styles.progressBar, width: widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }), backgroundColor: task.status == 'error' ? '#e64545' : theme['c-primary'] }} />
          </View>
          <Text numberOfLines={1} size={11} color={theme['c-font-label']} style={styles.progressText}>{`${progress}%`}</Text>
        </View>
        <Text numberOfLines={1} size={11} color={task.status == 'error' ? '#e64545' : theme['c-font-label']} style={styles.itemStatus}>{isCompleted ? `${statusText} · ${qualityLabel} · ${(task.metadata.ext || '').toUpperCase()}` : statusText}</Text>
      </TouchableOpacity>
      <View style={styles.itemActions}>
        {
          isRun
            ? <TouchableOpacity style={styles.actionBtn} onPress={() => { pauseTask(task.id) }}>
                <Icon name="pause" size={18} color={theme['c-font-label']} />
              </TouchableOpacity>
            : canResume
              ? <TouchableOpacity style={styles.actionBtn} onPress={handleResume}>
                  <Icon name="play" size={18} color={theme['c-primary']} />
                </TouchableOpacity>
              : null
        }
        <TouchableOpacity style={styles.actionBtn} onPress={handleDelete}>
          <Icon name="close" size={16} color={theme['c-font-label']} />
        </TouchableOpacity>
      </View>
    </View>
  )
})

const FilterBar = ({ filter, setFilter, counts }: {
  filter: Filter
  setFilter: (filter: Filter) => void
  counts: Record<Filter, number>
}) => {
  const theme = useTheme()
  const t = useI18n()
  const list = [
    { id: FILTER_ALL, name: t('download_page_filter_all') },
    { id: FILTER_RUNNING, name: t('download_page_filter_running') },
    { id: FILTER_DONE, name: t('download_page_filter_done') },
  ] as const

  return (
    <View style={styles.filterBar}>
      {
        list.map(({ id, name }) => {
          const active = id == filter
          return (
            <TouchableOpacity key={id} style={{ ...styles.filterItem, backgroundColor: active ? theme['c-primary-alpha-300'] : 'transparent' }} onPress={() => { setFilter(id) }}>
              <Text size={12} color={active ? theme['c-primary-font'] : theme['c-font-label']}>{`${name} ${counts[id]}`}</Text>
            </TouchableOpacity>
          )
        })
      }
    </View>
  )
}

const Header = ({ showClear, showPause, showStart, done, total, totalSize }: {
  showClear: boolean
  showPause: boolean
  showStart: boolean
  done: number
  total: number
  totalSize: number
}) => {
  const theme = useTheme()
  const t = useI18n()

  const handleClear = useCallback(() => {
    void confirmDialog({
      message: t('download_clear_completed_tip'),
      confirmButtonText: t('download_clear_button'),
    }).then(isClear => {
      if (!isClear) return
      void clearCompletedTasks()
    })
  }, [t])

  return (
    <View style={styles.header}>
      <View style={styles.headerTitleContent}>
        <Text size={20}>{t('nav_download')}</Text>
        <Text size={11} color={theme['c-font-label']} style={styles.headerSummary}>{t('download_page_summary', { done, total })}{totalSize > 0 ? `  ·  ${t('download_page_total_size', { size: formatSize(totalSize) })}` : ''}</Text>
      </View>
      {
        showStart
          ? <TouchableOpacity style={styles.headerBtn} onPress={() => { startAllTasks() }}>
              <Icon name="play" size={18} color={theme['c-font-label']} />
            </TouchableOpacity>
          : null
      }
      {
        showPause
          ? <TouchableOpacity style={styles.headerBtn} onPress={() => { pauseAllTasks() }}>
              <Icon name="pause" size={18} color={theme['c-font-label']} />
            </TouchableOpacity>
          : null
      }
      {
        showClear
          ? <TouchableOpacity style={styles.headerBtn} onPress={handleClear}>
              <Icon name="remove" size={18} color={theme['c-font-label']} />
            </TouchableOpacity>
          : null
      }
    </View>
  )
}

export default () => {
  const theme = useTheme()
  const t = useI18n()
  const list = useDownloadList()
  const [filter, setFilter] = useState<Filter>(FILTER_ALL)
  const [saveDir, setSaveDir] = useState(downloadState.saveDir)

  useEffect(() => {
    if (downloadState.saveDir && downloadState.saveDir != saveDir) setSaveDir(downloadState.saveDir)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list])

  const doneCount = useMemo(() => list.filter(task => task.status == 'completed').length, [list])
  const totalSize = useMemo(() => list.reduce((sum, task) => sum + (task.status == 'completed' ? (task.total || 0) : 0), 0), [list])
  const runningCount = list.length - doneCount
  const counts = useMemo(() => ({
    [FILTER_ALL]: list.length,
    [FILTER_RUNNING]: runningCount,
    [FILTER_DONE]: doneCount,
  }), [list.length, runningCount, doneCount])

  const showStart = useMemo(() => list.some(task => task.status == 'pause' || task.status == 'error' || task.status == 'waiting'), [list])
  const showPause = useMemo(() => list.some(task => task.status == 'run' || task.status == 'waiting'), [list])
  const showClear = doneCount > 0

  const showList = useMemo(() => {
    switch (filter) {
      case FILTER_RUNNING:
        return list.filter(task => task.status != 'completed')
      case FILTER_DONE:
        return list.filter(task => task.status == 'completed')
      case FILTER_ALL:
      default:
        return list
    }
  }, [list, filter])

  return (
    <View style={styles.container}>
      <Header showClear={showClear} showPause={showPause} showStart={showStart} done={doneCount} total={list.length} totalSize={totalSize} />
      <FilterBar filter={filter} setFilter={setFilter} counts={counts} />
      <FlatList
        data={showList}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => <TaskItem task={item} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="download-2" size={48} color={theme['c-font-label']} />
            <Text color={theme['c-font-label']} style={styles.emptyText}>{t('download_list_empty')}</Text>
            <Text size={12} color={theme['c-font-label']} style={styles.emptyTip}>{t('download_list_empty_tip')}</Text>
          </View>
        }
        ListFooterComponent={
          saveDir
            ? <TouchableOpacity onPress={() => { clipboardWriteText(saveDir); toast(t('download_page_copy_path_tip')) }}>
                <Text size={11} color={theme['c-font-label']} style={styles.saveDir} numberOfLines={2}>{t('download_save_dir', { path: saveDir })}</Text>
              </TouchableOpacity>
            : null
        }
      />
    </View>
  )
}

const styles = createStyle({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 15,
    paddingRight: 10,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerTitleContent: {
    flex: 1,
  },
  headerSummary: {
    marginTop: 2,
  },
  headerBtn: {
    paddingLeft: 12,
    paddingRight: 6,
    paddingTop: 6,
    paddingBottom: 6,
  },
  filterBar: {
    flexDirection: 'row',
    paddingLeft: 12,
    paddingRight: 12,
    paddingBottom: 8,
  },
  filterItem: {
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 5,
    paddingBottom: 5,
    borderRadius: 20,
    marginRight: 8,
  },
  listContent: {
    flexGrow: 1,
    paddingLeft: 10,
    paddingRight: 10,
    paddingBottom: 15,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    marginBottom: 8,
    borderRadius: 10,
  },
  picContent: {
    width: scaleSizeH(46),
    height: scaleSizeH(46),
    marginRight: 10,
  },
  pic: {
    width: scaleSizeH(46),
    height: scaleSizeH(46),
    borderRadius: 6,
    overflow: 'hidden',
  },
  picBadge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemContent: {
    flex: 1,
    flexDirection: 'column',
  },
  itemSinger: {
    marginTop: 2,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  progressBarBg: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBar: {
    height: 4,
    borderRadius: 2,
  },
  progressText: {
    width: 38,
    textAlign: 'right',
  },
  itemStatus: {
    marginTop: 4,
  },
  itemActions: {
    flexDirection: 'column',
    alignItems: 'center',
    marginLeft: 6,
  },
  actionBtn: {
    padding: 6,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  emptyText: {
    marginTop: 15,
  },
  emptyTip: {
    marginTop: 8,
    textAlign: 'center',
    paddingLeft: 20,
    paddingRight: 20,
  },
  saveDir: {
    textAlign: 'center',
    paddingTop: 10,
  },
})
