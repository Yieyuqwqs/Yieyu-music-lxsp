import { memo, useRef } from 'react'
import { TouchableOpacity, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import Text from '@/components/common/Text'
import FileSelect, { type FileSelectType } from '@/components/common/FileSelect'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { exportEncryptedBackup, importEncryptedBackup } from '@/core/encryptedBackup'
import { importLocalMusicFolder } from '@/core/localImport'
import { readFile, writeFile } from '@/utils/fs'
import { createStyle, toast } from '@/utils/tools'

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const fileSelectRef = useRef<FileSelectType>(null)

  const handleExport = () => {
    fileSelectRef.current?.show({ title: t('setting_backup_encrypted_export_title'), isPersist: false, filter: ['json', 'txt'] }, (path: string) => {
      if (!path) return
      void exportEncryptedBackup().then(content => {
        const savePath = /\.\w+$/.test(path) ? path : `${path}.json`
        return writeFile(savePath, content).then(() => {
          toast(t('setting_backup_encrypted_export_success'))
        })
      }).catch(() => {
        toast(t('setting_backup_encrypted_failed'))
      })
    })
  }

  const handleImport = () => {
    fileSelectRef.current?.show({ title: t('setting_backup_encrypted_export_title'), isPersist: false, filter: ['json', 'txt'] }, (path: string) => {
      if (!path) return
      void readFile(path).then(content => importEncryptedBackup(content)).then(count => {
        toast(t('setting_backup_encrypted_import_success', { num: count }))
      }).catch(() => {
        toast(t('setting_backup_encrypted_failed'))
      })
    })
  }

  const handleScanLocal = () => {
    fileSelectRef.current?.show({ title: t('setting_backup_scan_dir_title'), isPersist: true, dirOnly: true }, (path: string) => {
      if (!path) return
      toast(t('setting_backup_scan_running'), 'long')
      void importLocalMusicFolder(path).then(count => {
        if (count) toast(t('setting_backup_scan_success', { num: count }), 'long')
        else toast(t('setting_backup_scan_empty'), 'long')
      }).catch(() => {
        toast(t('setting_backup_scan_failed'), 'long')
      })
    })
  }

  return (
    <SubTitle title={t('setting_backup_encrypted')}>
      <View style={styles.row}>
        <TouchableOpacity style={{ ...styles.btn, backgroundColor: theme['c-primary-alpha-300'] }} onPress={handleExport}>
          <Text size={12}>{t('setting_backup_encrypted_export')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={{ ...styles.btn, backgroundColor: theme['c-primary-alpha-200'], marginLeft: 10 }} onPress={handleImport}>
          <Text size={12}>{t('setting_backup_encrypted_import')}</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={{ ...styles.btn, backgroundColor: theme['c-primary-alpha-200'] }} onPress={handleScanLocal}>
        <Text size={12}>{t('setting_backup_scan_local')}</Text>
      </TouchableOpacity>
      <FileSelect ref={fileSelectRef} />
    </SubTitle>
  )
})

const styles = createStyle({
  row: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  btn: {
    paddingLeft: 14,
    paddingRight: 14,
    paddingTop: 8,
    paddingBottom: 8,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
})
