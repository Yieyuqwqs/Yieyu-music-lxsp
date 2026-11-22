/* eslint-disable @typescript-eslint/no-var-requires */
import { getUserTheme, saveUserTheme } from '@/utils/data'
import themes from '@/theme/themes/themes'
import settingState from '@/store/setting/state'
import themeState from '@/store/theme/state'
import { isUrl } from '@/utils'
import { privateStorageDirectoryPath } from '@/utils/fs'
import { type ImageSourcePropType } from 'react-native'

export const BG_IMAGES = {
  'china_ink.jpg': require('./images/china_ink.jpg') as ImageSourcePropType,
  'jqbg.jpg': require('./images/jqbg.jpg') as ImageSourcePropType,
  'landingMoon.png': require('./images/landingMoon2.png') as ImageSourcePropType,
  'myzcbg.jpg': require('./images/myzcbg.jpg') as ImageSourcePropType,
  'xnkl.png': require('./images/xnkl.png') as ImageSourcePropType,
} as const


let userThemes: LX.Theme[]
export const getAllThemes = async() => {
  // eslint-disable-next-line require-atomic-updates
  userThemes ??= await getUserTheme()
  return {
    themes,
    userThemes,
    dataPath: privateStorageDirectoryPath + '/theme_images',
  }
}

export const saveTheme = async(theme: LX.Theme) => {
  const targetTheme = userThemes.find(t => t.id === theme.id)
  if (targetTheme) Object.assign(targetTheme, theme)
  else userThemes.push(theme)
  await saveUserTheme(userThemes)
}

export const removeTheme = async(id: string) => {
  const index = userThemes.findIndex(t => t.id === id)
  if (index < 0) return
  userThemes.splice(index, 1)
  await saveUserTheme(userThemes)
}

export type LocalTheme = typeof themes[number]
type ColorsKey = keyof LX.Theme['config']['themeColors']
type ExtInfoKey = keyof LX.Theme['config']['extInfo']
const varColorRxp = /^var\((.+)\)$/
const { createThemeColors } = require('./utils')

export const buildActiveThemeColors = (theme: LX.Theme): LX.ActiveTheme => {
  // 使用副本，避免污染主题原始数据（否则切换主题/自定义主色后会残留错误颜色）
  const themeColors = { ...theme.config.themeColors }
  // 自定义主色：基于当前主题重新生成整套主色
  const customPrimary: string = settingState.setting['theme.customPrimary'] ?? ''
  if (customPrimary) {
    try {
      const generated = createThemeColors(customPrimary, themeColors['c-850'], theme.isDark)
      // 只覆盖主色相关的色值，避免把文字灰阶等颜色覆盖成黑色/错误颜色
      const primaryOnly: Record<string, string> = {}
      for (const [key, value] of Object.entries(generated)) {
        if (!key.startsWith('c-primary')) continue
        primaryOnly[key] = value as string
      }
      Object.assign(themeColors, primaryOnly)
    } catch {}
  }
  let bgImg: ImageSourcePropType | undefined
  if (theme.isCustom) {
    if (theme.config.extInfo['bg-image']) {
      theme.config.extInfo['bg-image'] =
        isUrl(theme.config.extInfo['bg-image'])
          ? theme.config.extInfo['bg-image']
          : `${privateStorageDirectoryPath}/theme_images/${theme.config.extInfo['bg-image']}`
    }
  } else {
    const extInfo = (theme as LocalTheme).config.extInfo
    if (extInfo['bg-image']) {
      if (!theme.isDark || !settingState.setting['theme.hideBgDark']) bgImg = BG_IMAGES[extInfo['bg-image']]
    }
  }

  theme.config.extInfo = { ...theme.config.extInfo }

  for (const [k, v] of Object.entries(theme.config.extInfo) as Array<[ExtInfoKey, LX.Theme['config']['extInfo'][ExtInfoKey]]>) {
    if (!v.startsWith('var(')) continue
    theme.config.extInfo[k] = themeColors[v.replace(varColorRxp, '$1') as ColorsKey]
  }

  return {
    id: theme.id,
    name: theme.name,
    isDark: theme.isDark,
    ...themeColors,
    ...theme.config.extInfo,
    'c-font': themeColors['c-850'],
    'c-font-label': themeColors['c-450'],
    'c-primary-font': themeColors['c-primary'],
    'c-primary-font-hover': themeColors['c-primary-alpha-300'],
    'c-primary-font-active': themeColors['c-primary-dark-100-alpha-200'],
    'c-primary-background': themeColors['c-primary-light-400-alpha-700'],
    'c-primary-background-hover': themeColors['c-primary-light-300-alpha-800'],
    'c-primary-background-active': themeColors['c-primary-light-100-alpha-800'],
    'c-primary-input-background': themeColors['c-primary-light-400-alpha-700'],
    'c-button-font': themeColors['c-primary-alpha-100'],
    'c-button-font-selected': themeColors['c-primary-dark-100-alpha-100'],
    'c-button-background': themeColors['c-primary-light-400-alpha-700'],
    'c-button-background-selected': themeColors['c-primary-alpha-600'],
    'c-button-background-hover': themeColors['c-primary-light-300-alpha-600'],
    'c-button-background-active': themeColors['c-primary-light-100-alpha-600'],
    'c-list-header-border-bottom': themeColors['c-primary-alpha-900'],
    'c-content-background': themeColors['c-primary-light-1000'],
    'c-border-background': themeColors['c-primary-light-100-alpha-700'],
    'bg-image': bgImg,
  } as const
}


// const copyTheme = (theme: LX.Theme): LX.Theme => {
//   return {
//     ...theme,
//     config: {
//       ...theme.config,
//       extInfo: { ...theme.config.extInfo },
//       themeColors: { ...theme.config.themeColors },
//     },
//   }
// }
// type IDS = LocalTheme['id']
export const getTheme = async() => {
  // fs.promises.readdir()
  const shouldUseDarkColors = themeState.shouldUseDarkColors
  // let themeId = settingState.setting['theme.id'] == 'auto'
  //   ? shouldUseDarkColors
  //     ? settingState.setting['theme.darkId']
  //     : settingState.setting['theme.lightId']
  //   // : 'china_ink'
  //   : settingState.setting['theme.id']
  let themeId = settingState.setting['common.isAutoTheme'] && shouldUseDarkColors
    ? 'black'
    : settingState.setting['theme.id']
  // themeId = 'naruto'
  // themeId = 'pink'
  // themeId = 'black'
  let theme: LocalTheme | LX.Theme | undefined = themes.find(theme => theme.id == themeId)
  if (!theme) {
    userThemes = await getUserTheme()
    theme = userThemes.find(theme => theme.id == themeId)
    if (!theme) {
      themeId = settingState.setting['theme.id'] == 'auto' && shouldUseDarkColors ? 'black' : 'green'
      theme = themes.find(theme => theme.id == themeId) as LX.Theme
    }
  }

  return theme
}
