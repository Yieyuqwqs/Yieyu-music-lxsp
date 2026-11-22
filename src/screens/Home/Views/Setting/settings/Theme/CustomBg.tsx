import { memo, useCallback, useRef } from 'react'

import { Image, TouchableOpacity, View } from 'react-native'

import SubTitle from '../../components/SubTitle'
import FileSelect, { type FileSelectType } from '@/components/common/FileSelect'
import Text from '@/components/common/Text'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { createStyle, toast } from '@/utils/tools'
import { copyFile, readDir, unlink, privateStorageDirectoryPath } from '@/utils/fs'
import { scaleSizeH, scaleSizeW } from '@/utils/pixelRatio'

const IMAGE_FILTER = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif']

const getFileExt = (path: string) => {
  const result = /\.([a-zA-Z0-9]+)$/.exec(path)
  return result ? result[1].toLowerCase() : 'jpg'
}

/**
 * 将选中的图片复制到应用私有目录，避免临时文件被清理
 */
const cleanOldBg = async() => {
  try {
    const files = await readDir(privateStorageDirectoryPath)
    for (const file of files) {
      if (!file.name?.startsWith('custom-bg.')) continue
      await unlink(file.path).catch(() => {})
    }
  } catch {}
}

const saveCustomBg = async(path: string) => {
  const target = `${privateStorageDirectoryPath}/custom-bg.${getFileExt(path)}`
  try {
    await cleanOldBg()
    await unlink(target).catch(() => {})
    await copyFile(path, target)
    updateSetting({ 'theme.customBgPic': target })
  } catch {
    // 复制失败时直接使用原路径
    updateSetting({ 'theme.customBgPic': path })
  }
}

export default memo(() => {
  const t = useI18n()
  const theme = useTheme()
  const pic = useSettingValue('theme.customBgPic')
  const fileSelectRef = useRef<FileSelectType>(null)

  const handleSelect = useCallback(() => {
    fileSelectRef.current?.show({
      title: t('setting_theme_custom_bg_select_title'),
      isPersist: true,
      filter: IMAGE_FILTER,
    }, (path: string) => {
      if (!path) return
      void saveCustomBg(path).catch(() => {
        toast(t('setting_theme_custom_bg_failed'))
      })
    })
  }, [t])

  const handleClear = useCallback(() => {
    updateSetting({ 'theme.customBgPic': '' })
  }, [])

  const uri = pic ? (pic.startsWith('/') ? `file://${pic}` : pic) : ''

  return (
    <SubTitle title={t('setting_theme_custom_bg')}>
      <View style={styles.content}>
        {
          uri
            ? <Image source={{ uri }} style={styles.preview} resizeMode="cover" />
            : <View style={{ ...styles.preview, backgroundColor: theme['c-primary-alpha-200'] }}>
                <Text size={12} color={theme['c-font-label']}>{t('setting_theme_custom_bg_empty')}</Text>
              </View>
        }
        <View style={styles.btns}>
          <TouchableOpacity style={{ ...styles.btn, backgroundColor: theme['c-primary-alpha-400'] }} onPress={handleSelect} activeOpacity={0.7}>
            <Text>{t('setting_theme_custom_bg_select')}</Text>
          </TouchableOpacity>
          {
            pic
              ? <TouchableOpacity style={styles.btn} onPress={handleClear} activeOpacity={0.7}>
                  <Text color={theme['c-font-label']}>{t('setting_theme_custom_bg_clear')}</Text>
                </TouchableOpacity>
              : null
          }
        </View>
      </View>
      <FileSelect ref={fileSelectRef} />
    </SubTitle>
  )
})

const PREVIEW_WIDTH = scaleSizeW(180)

const styles = createStyle({
  content: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  preview: {
    width: PREVIEW_WIDTH,
    height: scaleSizeH(70),
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  btns: {
    flexDirection: 'column',
    marginLeft: 15,
  },
  btn: {
    paddingLeft: 15,
    paddingRight: 15,
    paddingTop: 7,
    paddingBottom: 7,
    borderRadius: 6,
    marginBottom: 8,
  },
})
