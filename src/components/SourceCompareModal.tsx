import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'

import Modal, { type ModalType } from '@/components/common/Modal'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import commonState from '@/store/common/state'
import { getOtherSource } from '@/core/music/utils'
import { addTasks } from '@/core/download'
import { createStyle, toast } from '@/utils/tools'

export interface SourceCompareModalType {
  show: (musicInfo: LX.Music.MusicInfoOnline) => void
}

const formatSize = (size?: string | null) => size ?? ''

/**
 * 多源同名歌曲对比：列出各音源的可用音质与大小，直接选源下载
 */
export default forwardRef<SourceCompareModalType, {}>((_props, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const modalRef = useRef<ModalType>(null)
  const [visible, setVisible] = useState(false)
  const [loading, setLoading] = useState(false)
  const [list, setList] = useState<LX.Music.MusicInfoOnline[]>([])

  useImperativeHandle(ref, () => ({
    show(musicInfo) {
      if (!visible) setVisible(true)
      setList([musicInfo])
      setLoading(true)
      requestAnimationFrame(() => {
        modalRef.current?.setVisible(true)
      })
      void getOtherSource(musicInfo, true).then(result => {
        setList([musicInfo, ...result.filter(item => item.source != musicInfo.source)])
      }).catch(() => {}).finally(() => {
        setLoading(false)
      })
    },
  }))

  const handleHide = () => {
    modalRef.current?.setVisible(false)
  }

  const handleDownload = (item: LX.Music.MusicInfoOnline) => {
    void addTasks([item]).then(({ added, skip }) => {
      if (added) toast(t('download_task_added_tip', { num: added }))
      else if (skip) toast(t('download_task_exists_tip'))
    })
  }

  if (!visible) return null

  return (
    <Modal ref={modalRef} bgHide bgColor="rgba(0,0,0,0.55)">
      <View style={styles.mask}>
        <View style={{ ...styles.card, backgroundColor: theme['c-content-background'] }}>
          <View style={styles.header}>
            <Text size={15}>{t('source_compare_title')}</Text>
            <TouchableOpacity onPress={handleHide} style={styles.closeBtn}>
              <Icon name="close" size={16} color={theme['c-font-label']} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.list}>
            {
              list.map((item, index) => {
                const qualitys = Object.entries(item.meta?._qualitys ?? {}) as Array<[string, { size: string | null } | undefined]>
                return (
                  <TouchableOpacity key={`${item.source}_${item.id}_${index}`} style={styles.row} onPress={() => { handleDownload(item) }} activeOpacity={0.7}>
                    <Text size={13} style={styles.sourceName}>{commonState.sourceNames[item.source] ?? item.source}</Text>
                    <Text size={11} color={theme['c-font-label']} style={styles.quality} numberOfLines={2}>
                      {qualitys.length ? qualitys.map(([quality, info]) => `${quality}${formatSize(info?.size) ? `(${formatSize(info?.size)})` : ''}`).join('  ') : '-'}
                    </Text>
                  </TouchableOpacity>
                )
              })
            }
            {loading ? <Text size={11} color={theme['c-font-label']}>{t('source_compare_loading')}</Text> : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
})

const styles = createStyle({
  mask: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '86%',
    maxHeight: '72%',
    borderRadius: 12,
    padding: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  closeBtn: {
    marginLeft: 'auto',
    padding: 4,
  },
  list: {
    maxHeight: 420,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 9,
    paddingBottom: 9,
  },
  sourceName: {
    width: 76,
  },
  quality: {
    flex: 1,
  },
})
