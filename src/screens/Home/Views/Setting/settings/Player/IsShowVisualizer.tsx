import { memo } from 'react'
import { View } from 'react-native'

import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { createStyle } from '@/utils/tools'
import CheckBoxItem from '../../components/CheckBoxItem'

export default memo(() => {
  const t = useI18n()
  const value = useSettingValue('player.visualizer.enable')
  const enable = value !== false
  const setEnable = (value: boolean) => {
    updateSetting({ 'player.visualizer.enable': value })
  }

  return (
    <View style={styles.content}>
      <CheckBoxItem check={enable} onChange={setEnable} label={t('setting_play_show_visualizer')} />
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
})
