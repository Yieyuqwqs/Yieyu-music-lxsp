/**
 * 全局字体族（壁纸/手写风皮肤用）
 *
 * 为什么放在设置里而不是写死：截图那套皮肤的灵魂是「楷体/手写」的标题感，
 * 但 Android 自带字体里只有 serif 系列能接近楷体（不同厂商 ROM 会有差异）。
 * 所以这里只提供「系统能保证存在」的三个族；真正的行书字体要打包 ttf，暂不引入。
 */
import { useSettingValue } from '@/store/setting/hook'

export { FONT_FAMILY_OPTIONS, isFontFamilyValue, type FontFamilyValue, type FontFamilyOption } from './fontOptions'

/** 给 Text 组件用的样式片段：没选就返回空对象，保证默认外观零变化 */
export const useFontFamilyStyle = (): { fontFamily?: string } => {
  const value = useSettingValue('theme.fontFamily')
  return value ? { fontFamily: value } : {}
}
