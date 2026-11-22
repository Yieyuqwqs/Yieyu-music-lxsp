import { memo, useMemo } from 'react'
import { FlatList, TouchableOpacity } from 'react-native'

import Section from '../components/Section'
import SubTitle from '../components/SubTitle'
import Text from '@/components/common/Text'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { clearHistory, useHistory } from '@/core/history'
import { generateDailyRecommend } from '@/core/dailyRecommend'
import { addTempPlayList } from '@/core/player/tempPlayList'
import { confirmDialog, createStyle, toast } from '@/utils/tools'

const pad = (num: number) => String(num).padStart(2, '0')
const formatTime = (time: number) => {
  const date = new Date(time)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const history = useHistory()

  const stats = useMemo(() => {
    const total = history.length
    const ids = new Set(history.map(item => item.musicInfo.id))
    const artistCount = new Map<string, number>()
    for (const item of history) {
      const singer = item.musicInfo.singer || '未知歌手'
      artistCount.set(singer, (artistCount.get(singer) ?? 0) + 1)
    }
    const topArtists = [...artistCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    return { total, unique: ids.size, topArtists }
  }, [history])

  const handleClear = () => {
    void confirmDialog({
      message: t('setting_history_clear_tip'),
      confirmButtonText: t('setting_history_clear'),
    }).then(isOk => {
      if (!isOk) return
      void clearHistory()
    })
  }

  const handlePlay = (item: LX.PlayHistoryItem) => {
    addTempPlayList([{ listId: '', musicInfo: item.musicInfo }])
  }

  return (
    <Section title={t('setting_history')}>
      <SubTitle title={t('setting_history_stats')}>
        <Text size={12} color={theme['c-font-label']}>{`${t('setting_history_total')} ${stats.total}`}</Text>
        <Text size={12} color={theme['c-font-label']} style={styles.line}>{`${t('setting_history_unique')} ${stats.unique}`}</Text>
        {
          stats.topArtists.map(([singer, num]) => (
            <Text key={singer} size={12} color={theme['c-font-label']} style={styles.line}>{`${singer}：${num}`}</Text>
          ))
        }
      </SubTitle>
      <SubTitle title={t('setting_history_daily')}>
        <TouchableOpacity
          onPress={() => {
            void generateDailyRecommend().then(num => {
              toast(t('setting_history_daily_done', { num }))
            }).catch(() => {
              toast(t('setting_history_daily_failed'))
            })
          }}
          style={{ ...styles.clearBtn, backgroundColor: theme['c-primary-alpha-400'] }}
        >
          <Text size={12}>{t('setting_history_daily_btn')}</Text>
        </TouchableOpacity>
      </SubTitle>
      <SubTitle title={t('setting_history_list')}>
        <TouchableOpacity onPress={handleClear} style={{ ...styles.clearBtn, backgroundColor: theme['c-primary-alpha-200'] }}>
          <Text size={12}>{t('setting_history_clear')}</Text>
        </TouchableOpacity>
        <FlatList
          style={styles.list}
          data={history}
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={5}
          keyExtractor={(item, index) => `${item.musicInfo.id}_${item.time}_${index}`}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.item} onPress={() => { handlePlay(item) }} activeOpacity={0.7}>
              <Text size={13} numberOfLines={1}>{item.musicInfo.name}</Text>
              <Text size={11} color={theme['c-font-label']} numberOfLines={1}>{`${item.musicInfo.singer || ''}  ${formatTime(item.time)}`}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text size={12} color={theme['c-font-label']}>{t('setting_history_empty')}</Text>}
        />
      </SubTitle>
    </Section>
  )
})

const styles = createStyle({
  line: {
    marginTop: 2,
  },
  clearBtn: {
    alignSelf: 'flex-start',
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 6,
    paddingBottom: 6,
    borderRadius: 8,
    marginBottom: 8,
  },
  list: {
    maxHeight: 420,
  },
  item: {
    paddingTop: 6,
    paddingBottom: 6,
  },
})
