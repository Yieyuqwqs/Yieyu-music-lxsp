// 颜色 / 对比度工具 —— 播放页歌词「自动对比度」用（纯前端计算，不碰原生）
//
// 目标：歌词底色亮 → 黑字，底色暗 → 白字，且保证对比度达标，不再出现
// 白字压在浅色主题上「瞎眼」的问题。
// 底色取值优先级：主题 c-main-background（叠在 c-content-background 上）→ 主题 isDark 兜底。

import { useMemo } from 'react'

import { useTheme } from '@/store/theme/hook'

export interface RGB {
  r: number
  g: number
  b: number
  a: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const toByte = (value: number) => clamp(Math.round(value), 0, 255)

/** 解析 #rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba()，解析不了返回 null */
export const parseColor = (input?: string | null): RGB | null => {
  if (!input) return null
  const value = String(input).trim().toLowerCase()
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }

  const hex = /^#([0-9a-f]{3,8})$/.exec(value)
  if (hex) {
    const h = hex[1]
    if (h.length === 3 || h.length === 4) {
      const r = parseInt(h[0] + h[0], 16)
      const g = parseInt(h[1] + h[1], 16)
      const b = parseInt(h[2] + h[2], 16)
      const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1
      return { r, g, b, a }
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      }
    }
    return null
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(value)
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    if (parts.length < 3 || parts.some(n => Number.isNaN(n))) return null
    return {
      r: toByte(parts[0]),
      g: toByte(parts[1]),
      b: toByte(parts[2]),
      a: parts.length > 3 ? clamp(parts[3], 0, 1) : 1,
    }
  }
  return null
}

/** top 叠在 bottom 上（普通 alpha 合成） */
export const composite = (top: RGB, bottom: RGB): RGB => {
  const a = clamp(top.a + bottom.a * (1 - top.a), 0, 1)
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
}

/** WCAG 相对亮度（0 黑 ~ 1 白） */
export const relativeLuminance = (color: RGB): number => {
  const channel = (value: number) => {
    const v = clamp(value, 0, 255) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** 两段亮度之间的对比度（1 ~ 21） */
export const contrastRatio = (a: number, b: number): number => {
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  return (hi + 0.05) / (lo + 0.05)
}

const toCss = (color: RGB, alpha = color.a): string => {
  const a = clamp(alpha, 0, 1)
  return a >= 0.999
    ? `rgb(${toByte(color.r)}, ${toByte(color.g)}, ${toByte(color.b)})`
    : `rgba(${toByte(color.r)}, ${toByte(color.g)}, ${toByte(color.b)}, ${a.toFixed(2)})`
}

const mix = (from: RGB, to: RGB, ratio: number): RGB => ({
  r: from.r + (to.r - from.r) * ratio,
  g: from.g + (to.g - from.g) * ratio,
  b: from.b + (to.b - from.b) * ratio,
  a: 1,
})

const BLACK: RGB = { r: 0, g: 0, b: 0, a: 1 }
const WHITE: RGB = { r: 255, g: 255, b: 255, a: 1 }

/** 底色上应该用黑字还是白字（谁对比度高用谁） */
export const pickOnColor = (background: RGB): RGB => {
  const lum = relativeLuminance(background)
  return contrastRatio(lum, 0) >= contrastRatio(lum, 1) ? BLACK : WHITE
}

/**
 * 把颜色往黑/白方向推，直到与底色达到 minRatio 的对比度；推不到极限也返回极限色。
 * 用于「主题主色 / 灰色」这类本来不保证对比度的颜色。
 */
export const ensureContrast = (color: string | RGB, background: string | RGB, minRatio = 4.5): string => {
  const fg = typeof color === 'string' ? parseColor(color) : color
  const bg = typeof background === 'string' ? parseColor(background) : background
  if (!fg || !bg) return typeof color === 'string' ? color : toCss(color)
  const flatBg = { ...bg, a: 1 }
  const base = composite({ ...fg, a: fg.a }, flatBg)
  const bgLum = relativeLuminance(flatBg)
  if (contrastRatio(relativeLuminance(base), bgLum) >= minRatio) return toCss(base)
  const pushTo = relativeLuminance(pickOnColor(flatBg)) > 0.5 ? WHITE : BLACK
  let best = mix(base, pushTo, 1)
  for (let step = 1; step <= 20; step++) {
    const candidate = mix(base, pushTo, step / 20)
    best = candidate
    if (contrastRatio(relativeLuminance(candidate), bgLum) >= minRatio) break
  }
  return toCss(best)
}

/**
 * 在底色上取一个「同色系但更淡」的颜色：找到刚好达到 minRatio 的最小 alpha，
 * 并且不超过 maxAlpha（保留层次感）。
 */
export const alphaForContrast = (
  color: string | RGB,
  background: string | RGB,
  minRatio = 4.5,
  maxAlpha = 0.92,
  minAlpha = 0.28,
): string => {
  const fg = typeof color === 'string' ? parseColor(color) : color
  const bg = typeof background === 'string' ? parseColor(background) : background
  if (!fg || !bg) return typeof color === 'string' ? color : toCss(color)
  const flatBg = { ...bg, a: 1 }
  const bgLum = relativeLuminance(flatBg)
  const solid = composite({ ...fg, a: 1 }, flatBg)
  for (let alpha = minAlpha; alpha <= maxAlpha; alpha += 0.04) {
    const candidate = composite({ ...solid, a: alpha }, flatBg)
    if (contrastRatio(relativeLuminance(candidate), bgLum) >= minRatio) return toCss(candidate)
  }
  return toCss(composite({ ...solid, a: maxAlpha }, flatBg))
}

/** 歌词页底色（主题 c-main-background 叠在 c-content-background 上） */
export const resolveSurfaceColor = (
  mainBackground?: string,
  contentBackground?: string,
  isDark?: boolean,
): RGB => {
  const fallback = isDark ? { ...BLACK, r: 18, g: 18, b: 20, a: 1 } : { ...WHITE, r: 250, g: 250, b: 250, a: 1 }
  const base = parseColor(contentBackground) ?? fallback
  const top = parseColor(mainBackground)
  const flatBase = { ...base, a: 1 }
  if (!top) return flatBase
  return composite(top, flatBase)
}

export interface LyricPalette {
  /** 推算出的歌词底色（调试 / 自检用） */
  surface: string
  /** 底色亮度 0~1 */
  luminance: number
  /** 亮底 → 黑字；暗底 → 白字 */
  isLight: boolean
  /** 当前行主色（满对比度） */
  active: string
  /** 当前行副色（译文 / 卡拉OK 未播部分） */
  activeSecondary: string
  /** 卡拉OK 已播部分 */
  played: string
  /** 非当前行 */
  inactive: string
  /** 非当前行副色（译文） */
  inactiveSecondary: string
  /** 主题主色在底色上的安全版本 */
  accent: string
  /** 主色安全版本的半透明版 */
  accentSecondary: string
  /** 星光光晕颜色（自定义歌词色 / 主题主色推出来的发光色） */
  glow: string
  /** 文字阴影：亮底用淡白，暗底用淡黑，多一层保险 */
  shadowColor: string
  shadowRadius: number
  shadowOffset: { width: number, height: number }
}

/**
 * 由主题算出一整套歌词颜色。
 * 亮底：黑字 + 白色淡描边；暗底：白字 + 黑色淡描边。
 * @param customActive 用户在设置页自定义的歌词颜色（空 / 非法值 = 走自动对比度）
 * @param hasBgPic 播放页是否铺了动态背景图：图 + 暗度蒙版下真实底色接近黑，
 *                 不能只看主题里的 c-main-background（它可能是浅色的半透明层），否则会算成黑字瞎眼
 */
export const resolveLyricPalette = (
  theme: { [key: string]: string | number | undefined, isDark?: boolean },
  customActive?: string,
  hasBgPic?: boolean,
): LyricPalette => {
  // 动态背景图场景：图本身 + theme.bgDark 蒙版（默认 76%）→ 按深色底处理
  const surfaceRgb = hasBgPic
    ? { r: 18, g: 18, b: 21, a: 1 }
    : resolveSurfaceColor(
        theme['c-main-background'] as string | undefined,
        theme['c-content-background'] as string | undefined,
        theme.isDark === true,
      )
  const surface = toCss(surfaceRgb)
  const luminance = relativeLuminance(surfaceRgb)
  const isLight = contrastRatio(luminance, 0) >= contrastRatio(luminance, 1)
  const on = pickOnColor(surfaceRgb)
  const onCss = toCss(on)
  const primary = theme['c-primary'] as string | undefined

  // 自定义歌词色：只在「实在看不清」时往黑白方向轻推（保留用户选的色相），否则原样用
  const custom = parseColor(customActive ?? '')
  const activeCss = custom ? ensureContrast(custom, surface, 2.6) : onCss
  const accentCss = ensureContrast(primary ?? onCss, surface, 4.5)
  // 星光光晕：自定义色优先，其次主题主色；暗底往白里提亮才有「发光」感
  const glowBase = custom ?? parseColor(accentCss)
  const glow = glowBase ? toCss(mix(glowBase, WHITE, isLight ? 0.06 : 0.42)) : onCss

  return {
    surface,
    luminance,
    isLight,
    // 主行：满对比度（亮底黑 / 暗底白），对比度 ≥ 15:1
    active: activeCss,
    activeSecondary: alphaForContrast(activeCss, surface, isLight ? 6 : 5.5, 0.9),
    played: activeCss,
    inactive: alphaForContrast(onCss, surface, isLight ? 3.6 : 3.2, 0.62),
    inactiveSecondary: alphaForContrast(onCss, surface, isLight ? 2.6 : 2.4, 0.5),
    accent: accentCss,
    accentSecondary: alphaForContrast(accentCss, surface, 3.4, 0.8),
    glow,
    shadowColor: isLight ? 'rgba(255, 255, 255, 0.72)' : 'rgba(0, 0, 0, 0.55)',
    shadowRadius: 2,
    shadowOffset: { width: 0.2, height: 0.2 },
  }
}

/**
 * 播放页歌词配色 hook：跟着主题 + 自定义歌词色走。
 * 亮底 → 黑字，暗底 → 白字，并给出达标的次要色 / 主色 / 星光光晕色。
 */
/**
 * 播放页歌词配色 hook：跟着主题 + 自定义歌词色 + 是否有动态背景图走。
 * 亮底 → 黑字，暗底 → 白字，并给出达标的次要色 / 主色 / 星光光晕色。
 */
export const useLyricPalette = (customActive?: string, hasBgPic?: boolean): LyricPalette => {
  const theme = useTheme()
  return useMemo(
    () => resolveLyricPalette(
      theme as unknown as { [key: string]: string | number | undefined, isDark?: boolean },
      customActive,
      hasBgPic,
    ),
    [theme, customActive, hasBgPic],
  )
}
