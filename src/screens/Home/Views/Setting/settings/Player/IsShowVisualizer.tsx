import { memo } from 'react'
import { View } from 'react-native'

import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { useIsPro } from '@/store/license/hook'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { isVisualizerSupported } from '@/plugins/player/soundEffect/visualizer'
import Text from '@/components/common/Text'
import CheckBoxItem from '../../components/CheckBoxItem'

/**
 * 播放页可视化背景。
 *
 * 这里必须把「为什么看不见」直接写出来：
 * 开关只是三个条件之一，另外两个是「会员已解锁（active）」和「本机音效模块带可视化」。
 * 以前这三条任意一条不满足，开关照样是蓝的，用户只能怀疑"是不是被删了"。
 */
export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const value = useSettingValue('player.visualizer.enable')
  const isPro = useIsPro()
  const enable = value !== false
  const setEnable = (value: boolean) => {
    updateSetting({ 'player.visualizer.enable': value })
  }

  const supported = isVisualizerSupported
  let hint = ''
  if (!isPro) hint = t('setting_play_show_visualizer_need_pro')
  else if (!supported) hint = t('setting_play_show_visualizer_unsupported')

  return (
    <View style={styles.content}>
      <CheckBoxItem check={enable} onChange={setEnable} label={t('setting_play_show_visualizer')} />
      {hint ? <Text size={12} color={theme['c-font-label']} style={styles.hint}>{hint}</Text> : null}
    </View>
  )
})

const styles = createStyle({
  content: {
    marginTop: 5,
  },
  hint: {
    paddingLeft: 34,
    marginTop: 2,
    marginBottom: 4,
    lineHeight: 16,
  },
})
