/**
 * 全局字体族：可选项（纯常量，无 React 依赖 —— 设置页和自动化测试都要用）
 */
export type FontFamilyValue = '' | 'serif' | 'sans-serif-light'

export interface FontFamilyOption {
  id: FontFamilyValue
  labelKey: 'setting_theme_font_family_system' | 'setting_theme_font_family_serif' | 'setting_theme_font_family_light'
}

export const FONT_FAMILY_OPTIONS: readonly FontFamilyOption[] = [
  { id: '', labelKey: 'setting_theme_font_family_system' },
  { id: 'serif', labelKey: 'setting_theme_font_family_serif' },
  { id: 'sans-serif-light', labelKey: 'setting_theme_font_family_light' },
]

export const isFontFamilyValue = (value: unknown): value is FontFamilyValue => (
  value === '' || value === 'serif' || value === 'sans-serif-light'
)
