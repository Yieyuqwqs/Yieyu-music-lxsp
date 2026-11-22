import { memo } from 'react'
import { TouchableOpacity, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { createStyle } from '@/utils/tools'

const COLORS = [
  'rgb(77, 175, 124)',
  'rgb(52, 152, 219)',
  'rgb(26, 188, 156)',
  'rgb(155, 89, 182)',
  'rgb(236, 64, 122)',
  'rgb(231, 76, 60)',
  'rgb(230, 126, 34)',
  'rgb(241, 196, 15)',
  'rgb(96, 125, 139)',
  'rgb(63, 81, 181)',
  'rgb(0, 150, 136)',
  'rgb(121, 85, 72)',
]

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const current = useSettingValue('theme.customPrimary')

  return (
    <SubTitle title={t('setting_theme_custom_primary')}>
      <View style={styles.list}>
        {
          COLORS.map(color => (
            <TouchableOpacity
              key={color}
              style={{ ...styles.item, backgroundColor: color, borderWidth: current == color ? 2 : 0, borderColor: theme['c-font'] }}
              onPress={() => { updateSetting({ 'theme.customPrimary': color }) }}
            />
          ))
        }
        <TouchableOpacity style={styles.reset} onPress={() => { updateSetting({ 'theme.customPrimary': '' }) }}>
          <Text size={11} color={theme['c-font-label']}>{t('setting_theme_custom_primary_reset')}</Text>
        </TouchableOpacity>
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  item: {
    width: 34,
    height: 34,
    borderRadius: 17,
    marginRight: 10,
    marginBottom: 10,
  },
  reset: {
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 6,
    paddingBottom: 6,
    marginBottom: 10,
  },
})
