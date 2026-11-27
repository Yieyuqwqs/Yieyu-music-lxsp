import { memo } from 'react'
import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import PillOption from '../../components/PillOption'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { FONT_FAMILY_OPTIONS } from '@/theme/fontOptions'
import { createStyle } from '@/utils/tools'

/**
 * 全局字体：壁纸类皮肤（如「雪见」）配「衬线」就有楷体/手写感。
 * 只提供系统保证存在的三个族 —— 真正的行书字体需要打包 ttf，暂不引入。
 */
export default memo(() => {
  const t = useI18n()
  const current = useSettingValue('theme.fontFamily')

  return (
    <SubTitle title={t('setting_theme_font_family')}>
      <View style={styles.list}>
        {
          FONT_FAMILY_OPTIONS.map(({ id, labelKey }) => (
            <PillOption
              key={id || 'system'}
              active={(current ?? '') === id}
              label={t(labelKey)}
              onPress={() => { updateSetting({ 'theme.fontFamily': id }) }}
            />
          ))
        }
      </View>
    </SubTitle>
  )
})

const styles = createStyle({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
})
