import { memo } from 'react'

import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import PillOption from '../../components/PillOption'
import { useSettingValue } from '@/store/setting/hook'
import { updateSetting } from '@/core/common'
import { useI18n } from '@/lang'
import { QUALITY_OPTIONS } from '@/config/quality'
import { createStyle } from '@/utils/tools'

export default memo(() => {
  const t = useI18n()
  const currentQuality = useSettingValue('player.playQuality')

  return (
    <SubTitle title={t('setting_play_play_quality')}>
      <View style={styles.list}>
        {
          QUALITY_OPTIONS.map(({ id, labelKey }) => (
            <PillOption
              key={id}
              active={currentQuality == id}
              label={t(labelKey as never)}
              onPress={() => { updateSetting({ 'player.playQuality': id }) }}
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
