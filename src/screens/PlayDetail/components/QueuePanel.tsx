import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'

import Modal, { type ModalType } from '@/components/common/Modal'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { useTempPlayList } from '@/store/player/hook'
import { removeTempPlayList, clearTempPlayeList } from '@/core/player/tempPlayList'
import { createStyle } from '@/utils/tools'

export interface QueuePanelType {
  show: () => void
}

/**
 * 稍后播放队列面板
 */
export default forwardRef<QueuePanelType, {}>((_props, ref) => {
  const t = useI18n()
  const theme = useTheme()
  const list = useTempPlayList()
  const modalRef = useRef<ModalType>(null)
  const [visible, setVisible] = useState(false)

  useImperativeHandle(ref, () => ({
    show() {
      if (!visible) setVisible(true)
      requestAnimationFrame(() => {
        modalRef.current?.setVisible(true)
      })
    },
  }))

  const handleHide = () => {
    modalRef.current?.setVisible(false)
  }

  if (!visible) return null

  return (
    <Modal ref={modalRef} bgHide bgColor="rgba(0,0,0,0.55)">
      <View style={styles.mask}>
        <View style={{ ...styles.card, backgroundColor: theme['c-content-background'] }}>
          <View style={styles.header}>
            <Text size={15}>{`${t('queue_title')} (${list.length})`}</Text>
            <View style={styles.headerBtns}>
              {
                list.length
                  ? <TouchableOpacity onPress={() => { clearTempPlayeList() }} style={styles.headerBtn}>
                      <Text size={12} color={theme['c-font-label']}>{t('queue_clear')}</Text>
                    </TouchableOpacity>
                  : null
              }
              <TouchableOpacity onPress={handleHide} style={styles.headerBtn}>
                <Icon name="close" size={16} color={theme['c-font-label']} />
              </TouchableOpacity>
            </View>
          </View>
          <ScrollView style={styles.list}>
            {
              list.length
                ? list.map((item, index) => (
                    <View key={`${item.musicInfo.id}_${index}`} style={styles.itemRow}>
                      <Text size={13} numberOfLines={1} style={styles.itemName}>{item.musicInfo.name}</Text>
                      <Text size={11} color={theme['c-font-label']} numberOfLines={1} style={styles.itemSinger}>{item.musicInfo.singer}</Text>
                      <TouchableOpacity onPress={() => { removeTempPlayList(index) }} style={styles.delBtn}>
                        <Icon name="close" size={12} color={theme['c-font-label']} />
                      </TouchableOpacity>
                    </View>
                  ))
                : <Text size={12} color={theme['c-font-label']}>{t('queue_empty')}</Text>
            }
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
    width: '82%',
    maxHeight: '70%',
    borderRadius: 12,
    padding: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  headerBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  headerBtn: {
    paddingLeft: 10,
    paddingTop: 4,
    paddingBottom: 4,
  },
  list: {
    maxHeight: 380,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 7,
    paddingBottom: 7,
  },
  itemName: {
    flexShrink: 1,
  },
  itemSinger: {
    flex: 1,
    marginLeft: 8,
  },
  delBtn: {
    padding: 6,
  },
})
