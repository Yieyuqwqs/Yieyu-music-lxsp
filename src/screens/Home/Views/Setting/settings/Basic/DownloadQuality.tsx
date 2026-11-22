import { memo } from 'react'

import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import PillOption from '../../components/PillOption'
import { useSettingValue } from '@/store/setting/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { QUALITY_OPTIONS } from '@/config/quality'
import { createStyle } from '@/utils/tools'

export default memo(() => {
  const t = useI18n()
  const currentQuality = useSettingValue('download.quality')

  return (
    <SubTitle title={t('setting_download_quality')}>
      <View style={styles.list}>
        {
          QUALITY_OPTIONS.map(({ id, labelKey }) => (
            <PillOption
              key={id}
              active={currentQuality == id}
              label={t(labelKey as never)}
              onPress={() => { updateSetting({ 'download.quality': id }) }}
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
