import { memo, useMemo } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

/**
 * 纯 RN 渐变（不引第三方库）：
 * 用一组等高的色带近似线性渐变，容器 overflow: hidden + borderRadius 即可做出圆角渐变按钮/卡片。
 * 颜色支持 #RGB/#RRGGBB/#RRGGBBAA/rgb()/rgba()。
 */
type RGBA = [number, number, number, number]

const WHITE: RGBA = [255, 255, 255, 1]

const clamp = (value: number) => Math.max(0, Math.min(255, value))

const parseColor = (input?: string): RGBA => {
  if (!input) return WHITE
  const color = input.trim()
  if (color[0] === '#') {
    const hex = color.slice(1)
    if (hex.length === 3) {
      return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16), 1]
    }
    if (hex.length === 6) return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1]
    if (hex.length === 8) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), parseInt(hex.slice(6, 8), 16) / 255]
    }
  }
  const rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(color)
  if (rgb) {
    return [
      Number(rgb[1]) || 0,
      Number(rgb[2]) || 0,
      Number(rgb[3]) || 0,
      rgb[4] == null ? 1 : Number(rgb[4]),
    ]
  }
  return WHITE
}

const mix = (from: RGBA, to: RGBA, t: number): string => {
  const r = Math.round(from[0] + (to[0] - from[0]) * t)
  const g = Math.round(from[1] + (to[1] - from[1]) * t)
  const b = Math.round(from[2] + (to[2] - from[2]) * t)
  const a = from[3] + (to[3] - from[3]) * t
  if (a >= 0.999) return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`
  return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`
}

interface Props {
  colors: string[]
  /** 近似色带数量，越大越细腻（默认 24） */
  steps?: number
  /** 渐变方向 */
  direction?: 'vertical' | 'horizontal' | 'diagonal'
  style?: StyleProp<ViewStyle>
  children?: React.ReactNode
}

export default memo(({ colors, steps = 24, direction = 'vertical', style, children }: Props) => {
  const bands = useMemo(() => {
    const list = colors.length ? colors : ['#000000', '#000000']
    const stopCount = Math.max(2, Math.min(64, Math.round(steps)))
    const result: string[] = []
    for (let i = 0; i < stopCount; i++) {
      const position = (i / (stopCount - 1)) * (list.length - 1)
      const index = Math.min(list.length - 2, Math.floor(position))
      result.push(mix(parseColor(list[index]), parseColor(list[index + 1] ?? list[index]), position - index))
    }
    return result
  }, [colors, steps])

  const horizontal = direction === 'horizontal'
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          flexDirection: horizontal ? 'row' : 'column',
          // 斜向渐变：色带在横向也错开一点，视觉上更像 135°
          transform: direction === 'diagonal' ? [{ rotate: '-8deg' }, { scale: 1.25 }] : undefined,
        }}
      >
        {bands.map((color, index) => (
          <View key={index} style={{ flex: 1, backgroundColor: color }} />
        ))}
      </View>
      {children}
    </View>
  )
})
