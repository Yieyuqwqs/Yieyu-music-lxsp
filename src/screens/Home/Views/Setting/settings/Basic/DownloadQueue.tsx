import { memo } from 'react'
import { View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import Slider from '@/components/common/Slider'
import CheckBoxItem from '../../components/CheckBoxItem'
import InputItem from '../../components/InputItem'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { createStyle } from '@/utils/tools'

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const threads = useSettingValue('download.maxThreads')
  const retry = useSettingValue('download.retryCount')
  const folderStructure = useSettingValue('download.folderStructure')
  const powerSaveMode = useSettingValue('common.powerSaveMode')
  const savePath = useSettingValue('download.savePath')

  return (
    <SubTitle title={t('setting_download_queue')}>
      <View style={styles.item}>
        <View style={styles.labelRow}>
          <Text size={12} color={theme['c-font-label']}>{t('setting_download_threads')}</Text>
          <Text size={12} color={theme['c-font-label']}>{threads}</Text>
        </View>
        <Slider value={threads} minimumValue={1} maximumValue={3} step={1} onSlidingComplete={(v) => { updateSetting({ 'download.maxThreads': Math.round(v) }) }} />
      </View>
      <View style={styles.item}>
        <View style={styles.labelRow}>
          <Text size={12} color={theme['c-font-label']}>{t('setting_download_retry')}</Text>
          <Text size={12} color={theme['c-font-label']}>{retry}</Text>
        </View>
        <Slider value={retry} minimumValue={0} maximumValue={5} step={1} onSlidingComplete={(v) => { updateSetting({ 'download.retryCount': Math.round(v) }) }} />
      </View>
      <InputItem
        value={savePath}
        label={t('setting_download_save_path')}
        placeholder={t('setting_download_save_path_placeholder')}
        onChanged={(text: string) => { updateSetting({ 'download.savePath': text.trim() }) }}
      />
      <CheckBoxItem check={folderStructure} label={t('setting_download_folder_structure')} onChange={(v: boolean) => { updateSetting({ 'download.folderStructure': v }) }} />
      <CheckBoxItem check={powerSaveMode} label={t('setting_common_power_save')} onChange={(v: boolean) => { updateSetting({ 'common.powerSaveMode': v }) }} />
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
