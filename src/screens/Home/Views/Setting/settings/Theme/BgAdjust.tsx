import { memo } from 'react'
import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import Slider from '@/components/common/Slider'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { createStyle } from '@/utils/tools'

const Item = ({ labelKey, settingKey, min, max, step, value }: {
  labelKey: string
  settingKey: 'theme.bgBlur' | 'theme.bgDark' | 'theme.bgSpeed'
  min: number
  max: number
  step: number
  value: number
}) => {
  const theme = useTheme()
  const t = useI18n()

  return (
    <View style={styles.item}>
      <View style={styles.labelRow}>
        <Text size={12} color={theme['c-font-label']}>{t(labelKey as never)}</Text>
        <Text size={12} color={theme['c-font-label']}>{value}{settingKey == 'theme.bgSpeed' ? 'x' : ''}</Text>
      </View>
      <Slider
        value={value}
        minimumValue={min}
        maximumValue={max}
        step={step}
        onSlidingComplete={(v) => { updateSetting({ [settingKey]: Math.round(v * 10) / 10 } as any) }}
      />
    </View>
  )
}

export default memo(() => {
  const t = useI18n()
  const blur = useSettingValue('theme.bgBlur')
  const dark = useSettingValue('theme.bgDark')
  const speed = useSettingValue('theme.bgSpeed')

  return (
    <SubTitle title={t('setting_theme_bg_adjust')}>
      <Item labelKey="setting_theme_bg_blur" settingKey="theme.bgBlur" min={0} max={50} step={1} value={blur} />
      <Item labelKey="setting_theme_bg_dark" settingKey="theme.bgDark" min={0} max={100} step={1} value={dark} />
      <Item labelKey="setting_theme_bg_speed" settingKey="theme.bgSpeed" min={0.2} max={3} step={0.2} value={speed} />
    </SubTitle>
  )
})

const styles = createStyle({
  item: {
    marginBottom: 6,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingRight: 30,
  },
})
