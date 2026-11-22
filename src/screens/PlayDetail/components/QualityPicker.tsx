import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { ScrollView, TouchableOpacity, View } from 'react-native'

import Modal, { type ModalType } from '@/components/common/Modal'
import Text from '@/components/common/Text'
import { Icon } from '@/components/common/Icon'
import { useTheme } from '@/store/theme/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { createStyle } from '@/utils/tools'
import { getQualityCandidates, getQualityLabelKey, getQualitySize } from '@/config/quality'

interface Option {
  id: LX.QualitySetting
  label: string
  size: string | null
}

export interface QualityPickerType {
  show: (musicInfo: LX.Music.MusicInfoOnline, onSelect: (quality: LX.QualitySetting) => void) => void
}

/**
 * 下载音质选择弹窗：列出该歌曲实际可用的音质及文件大小
 */
export default forwardRef<QualityPickerType, {}>((_props, ref) => {
  const theme = useTheme()
  const t = useI18n()
  const defaultQuality = useSettingValue('download.quality')
  const modalRef = useRef<ModalType>(null)
  const [visible, setVisible] = useState(false)
  const [options, setOptions] = useState<Option[]>([])
  const onSelectRef = useRef<(quality: LX.QualitySetting) => void>(() => {})

  useImperativeHandle(ref, () => ({
    show(musicInfo, onSelect) {
      onSelectRef.current = onSelect
      const available = getQualityCandidates('auto', musicInfo)
      const list: Option[] = available.map(quality => ({
        id: quality as LX.QualitySetting,
        label: `${t(getQualityLabelKey(quality as LX.QualitySetting) as never)}${['master', 'atmos', 'atmos_plus'].includes(quality) ? ' ' + t('quality_need_custom_source') : ''}`,
        size: getQualitySize(musicInfo, quality as LX.QualitySetting),
      }))
      if (list.length > 1) {
        list.push({ id: 'auto', label: t('quality_auto'), size: null })
      }
      setOptions(list)
      if (!visible) setVisible(true)
      requestAnimationFrame(() => {
        modalRef.current?.setVisible(true)
      })
    },
  }))

  const handlePress = (id: LX.QualitySetting) => {
    modalRef.current?.setVisible(false)
    onSelectRef.current(id)
  }

  const handleHide = () => {
    modalRef.current?.setVisible(false)
  }

  if (!visible) return null

  return (
    <Modal ref={modalRef} bgHide bgColor="rgba(0,0,0,0.55)">
      <View style={styles.mask}>
        <View style={{ ...styles.card, backgroundColor: theme['c-content-background'] }}>
          <View style={styles.titleContent}>
            <Text size={15}>{t('quality_pick_title')}</Text>
            <TouchableOpacity style={styles.closeBtn} onPress={handleHide}>
              <Icon name="close" size={16} color={theme['c-font-label']} />
            </TouchableOpacity>
          </View>
          <ScrollView>
            {
              options.map(item => (
                <TouchableOpacity key={item.id} style={styles.row} onPress={() => { handlePress(item.id) }} activeOpacity={0.7}>
                  <Text size={13} color={theme['c-font']}>
                    {item.size ? `${item.label} (${item.size})` : item.label}
                  </Text>
                  {
                    defaultQuality == item.id
                      ? <Icon name="checkbox-marked" size={14} color={theme['c-primary']} />
                      : null
                  }
                </TouchableOpacity>
              ))
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
    width: '78%',
    maxHeight: '70%',
    borderRadius: 12,
    paddingTop: 14,
    paddingBottom: 10,
    paddingLeft: 16,
    paddingRight: 16,
  },
  titleContent: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  closeBtn: {
    marginLeft: 'auto',
    padding: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 11,
    paddingBottom: 11,
  },
})
