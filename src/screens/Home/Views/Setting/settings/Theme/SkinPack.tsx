import { memo, useRef } from 'react'
import { TouchableOpacity, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import FileSelect, { type FileSelectType } from '@/components/common/FileSelect'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import settingState from '@/store/setting/state'
import { handleSaveFile, handleReadFile, toast, createStyle } from '@/utils/tools'

interface SkinData {
  skinVersion: number
  themeId: string
  customPrimary: string
  bgBlur: number
  bgDark: number
  bgSpeed: number
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const fileSelectRef = useRef<FileSelectType>(null)

  const handleExport = () => {
    const data: SkinData = {
      skinVersion: 1,
      themeId: settingState.setting['theme.id'],
      customPrimary: settingState.setting['theme.customPrimary'] ?? '',
      bgBlur: settingState.setting['theme.bgBlur'],
      bgDark: settingState.setting['theme.bgDark'],
      bgSpeed: settingState.setting['theme.bgSpeed'],
    }
    fileSelectRef.current?.show({ title: t('setting_theme_skin_export_title'), isPersist: false, filter: ['json'] }, (path: string) => {
      if (!path) return
      void handleSaveFile(path.endsWith('.json') ? path : path + '.json', data).then(() => {
        toast(t('setting_theme_skin_export_success'))
      }).catch(() => {
        toast(t('setting_theme_skin_failed'))
      })
    })
  }

  const handleImport = () => {
    fileSelectRef.current?.show({ title: t('setting_theme_skin_import_title'), isPersist: false, filter: ['json'] }, (path: string) => {
      if (!path) return
      void handleReadFile<SkinData>(path).then(data => {
        if (!data || (data as any).skinVersion == null) throw new Error('invalid skin')
        updateSetting({
          ...(data.themeId ? { 'theme.id': data.themeId } : {}),
          'theme.customPrimary': data.customPrimary ?? '',
          ...(typeof data.bgBlur == 'number' ? { 'theme.bgBlur': data.bgBlur } : {}),
          ...(typeof data.bgDark == 'number' ? { 'theme.bgDark': data.bgDark } : {}),
          ...(typeof data.bgSpeed == 'number' ? { 'theme.bgSpeed': data.bgSpeed } : {}),
        })
        toast(t('setting_theme_skin_import_success'))
      }).catch(() => {
        toast(t('setting_theme_skin_failed'))
      })
    })
  }

  return (
    <SubTitle title={t('setting_theme_skin')}>
      <View style={styles.row}>
        <TouchableOpacity style={{ ...styles.btn, backgroundColor: theme['c-primary-alpha-300'] }} onPress={handleExport}>
          <Text size={12}>{t('setting_theme_skin_export')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={{ ...styles.btn, backgroundColor: theme['c-primary-alpha-200'], marginLeft: 10 }} onPress={handleImport}>
          <Text size={12}>{t('setting_theme_skin_import')}</Text>
        </TouchableOpacity>
      </View>
      <FileSelect ref={fileSelectRef} />
    </SubTitle>
  )
})

const styles = createStyle({
  row: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  btn: {
    paddingLeft: 14,
    paddingRight: 14,
    paddingTop: 8,
    paddingBottom: 8,
    borderRadius: 8,
  },
})
