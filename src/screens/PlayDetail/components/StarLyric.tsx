// 星光跳动 · 逐字歌词（酷狗星空歌词风格）
//
// 性能红线（死命令）：
//   · 逐字跳动 / 星光光晕 **绝不** 用 JS setState 更新 DOM；
//   · 全部由 react-native-reanimated 的 useAnimatedStyle + withSpring 在 UI 线程驱动；
//   · 播放期间 JS 线程只负责「每秒一次的进度校准」，其余帧全部走原生动画；
//   · 本组件只读播放器状态，不写播放器、不触发任何音频调用。
//
// 时间单位（Aurora-25 修复）：
//   lrc-file-parser 的 Line.time 是 **毫秒**（PlayLine 里 `time / 1000` 就是证据），
//   而播放器进度 nowPlayTime 与共享时钟是 **秒**。
//   Aurora-24 直接把毫秒当秒用，导致每个字的 onset 都落在未来 → 逐字亮字层永远不显示。
//   这里统一把行级时间戳换算成秒，再切字级窗口。

import { memo, useMemo } from 'react'
import { View, Text as RNText } from 'react-native'
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'

import { useProgress, useIsPlay } from '@/store/player/hook'
import { useSettingValue } from '@/store/setting/hook'
import { setSpText } from '@/utils/pixelRatio'
import { createStyle } from '@/utils/tools'
import { getLyricClock, useLyricClockDriver } from '@/utils/lyricClock'
import { type LyricPalette } from '@/utils/colorContrast'

/** 弹簧参数：起跳干脆、回落不弹过头（mass 小 = 跟手） */
const SPRING = { damping: 12, stiffness: 320, mass: 0.45, overshootClamping: false }
/** 单行超过这个字数就不叠光晕层，保证再长的行也只有 2 层，绝不掉帧 */
const MAX_GLOW_CHARS = 64
/** 拿不到下一行时间时的兜底行长（秒） */
const FALLBACK_LINE_SEC = 6

/** 字权重：中文/英文按 1 拍，标点留白，空格略短 */
const weightOf = (char: string): number => {
  if (/\s/.test(char)) return 0.6
  if (/[，。！？、,.!?;:…—-]/.test(char)) return 0.55
  return 1
}

interface CharBoxProps {
  char: string
  /** 该字开始唱的时间（秒） */
  onset: number
  /** 该字唱完、交给下一个字的时间（秒） */
  offset: number
  fontSize: number
  lineHeight: number
  /** 上跳高度 */
  jump: number
  /** 放大到多少 */
  scaleTo: number
  palette: LyricPalette
  glowColor: string
  glowRadius: number
  withGlow: boolean
}

const CharBox = memo(({ char, onset, offset, fontSize, lineHeight, jump, scaleTo, palette, glowColor, glowRadius, withGlow }: CharBoxProps) => {
  const { clock } = getLyricClock()
  // 0 = 还没唱到，2 = 正在唱（跳起来），1 = 已经唱过（落回变暗）
  const phase = useDerivedValue(() => {
    const t = clock.value
    if (t < onset) return 0
    if (t < offset) return 2
    return 1
  })
  const lift = useSharedValue(0)

  // 只在「相位变化」那一刻触发一次弹簧，之后 60fps 由 native 动画自己跑
  useAnimatedReaction(() => phase.value, (cur, prev) => {
    if (cur === prev) return
    lift.value = withSpring(cur === 2 ? 1 : 0, SPRING)
  })

  const boxStyle = useAnimatedStyle(() => {
    const v = lift.value
    return {
      transform: [
        { translateY: -v * jump },
        { scale: 1 + v * (scaleTo - 1) },
      ],
    }
  })

  // 已唱的字保持主色、略暗；正在唱的字全亮（再叠星光层）
  const activeStyle = useAnimatedStyle(() => {
    const p = phase.value
    return { opacity: p === 0 ? 0 : (p === 2 ? 1 : 0.62) }
  })

  // 星光光晕：激活时炸开，落回后完全收掉
  const glowStyle = useAnimatedStyle(() => {
    const v = lift.value
    return {
      opacity: v * 0.95,
      transform: [{ scale: 1 + v * 0.5 }],
    }
  })

  const textBase = useMemo(() => ({
    fontSize,
    lineHeight,
    includeFontPadding: false,
    textAlignVertical: 'center' as const,
    fontWeight: '700' as const,
  }), [fontSize, lineHeight])

  // 底层永远用「当前行主色 × 0.55」：即使动效被系统关掉或掉帧，当前行也不会瞎眼
  const baseText = useMemo(() => [textBase, { color: palette.active, opacity: 0.55 }], [textBase, palette.active])
  const activeText = useMemo(() => [
    textBase,
    {
      color: palette.active,
      textShadowColor: palette.shadowColor,
      textShadowOffset: palette.shadowOffset,
      textShadowRadius: palette.shadowRadius,
    },
  ], [textBase, palette.active, palette.shadowColor, palette.shadowOffset, palette.shadowRadius])
  const glowText = useMemo(() => [
    textBase,
    {
      color: glowColor,
      textShadowColor: glowColor,
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: glowRadius,
    },
  ], [textBase, glowColor, glowRadius])

  return (
    <Animated.View style={[styles.char, boxStyle]}>
      {/* 底层：未唱到的当前行文字（半亮），同时负责撑开宽度、决定换行位置 */}
      <RNText allowFontScaling={false} style={baseText} textBreakStrategy="simple">{char}</RNText>
      {withGlow
        ? (
            // 星光层：压在字上但向外炸开，只有激活那一刻可见
            <Animated.View style={[styles.layer, glowStyle]} pointerEvents="none">
              <RNText allowFontScaling={false} style={glowText}>{char}</RNText>
            </Animated.View>
          )
        : null}
      {/* 顶层：亮色字，激活时全亮、唱完压暗 */}
      <Animated.View style={[styles.layer, activeStyle]} pointerEvents="none">
        <RNText allowFontScaling={false} style={activeText}>{char}</RNText>
      </Animated.View>
    </Animated.View>
  )
})

export interface StarLyricProps {
  text: string
  /** 该行歌词开始时间（毫秒，跟随 lrc-file-parser 的 Line.time） */
  startTime: number
  /** 该行歌词结束时间（毫秒） */
  endTime: number
  /** 字号（沿用 playDetail 的 size 单位） */
  size: number
  lineHeight: number
  textAlign?: 'left' | 'center' | 'right'
  palette: LyricPalette
  /** 光晕颜色（默认取调色板的 glow） */
  glowColor?: string
}

/**
 * 星光跳动逐字歌词。
 *
 * 逐字时间轴由「行开始/结束时间戳（毫秒）+ 字权重」推算：
 * 歌词解析器只给行级时间戳（lrc-file-parser 的 Line 只有 time/text/extendedLyrics），
 * 所以按字权重把行时长切成首尾相接的字级窗口 —— 上一个字在下一个字起跳的同一刻落回。
 */
export default memo(({ text, startTime, endTime, size, lineHeight, textAlign = 'center', palette, glowColor }: StarLyricProps) => {
  const fontSize = setSpText(size)
  const chars = useMemo(() => {
    const list = Array.from(text)
    if (!list.length) return []
    // 毫秒 → 秒；结束时间缺失/异常时用兜底行长
    const startSec = Number.isFinite(startTime) ? startTime / 1000 : 0
    const rawEnd = Number.isFinite(endTime) ? endTime / 1000 : startSec + FALLBACK_LINE_SEC
    const endSec = rawEnd > startSec + 0.2 ? rawEnd : startSec + FALLBACK_LINE_SEC
    const total = endSec - startSec
    const weights = list.map(weightOf)
    const sum = weights.reduce((a, b) => a + b, 0) || 1
    // 收尾留 8%：最后一个字不要拖到下一行开口
    const usable = total * 0.92
    let acc = 0
    return list.map((char, index) => {
      const from = startSec + (acc / sum) * usable
      acc += weights[index]
      const to = startSec + (acc / sum) * usable
      return {
        key: `${index}_${char}`,
        char: char === ' ' ? '\u00A0' : char,
        onset: from,
        offset: Math.max(from + 0.06, to),
      }
    })
  }, [text, startTime, endTime])

  const withGlow = chars.length <= MAX_GLOW_CHARS
  const glow = glowColor ?? palette.glow
  const jump = fontSize * 0.30
  const scaleTo = 1.22
  const glowRadius = Math.max(6, Math.round(fontSize * 0.5))

  if (!chars.length) return null

  return (
    <View
      style={[
        styles.row,
        { justifyContent: textAlign === 'left' ? 'flex-start' : textAlign === 'right' ? 'flex-end' : 'center' },
      ]}
      accessible
      accessibilityLabel={text}
    >
      {chars.map(item => (
        <CharBox
          key={item.key}
          char={item.char}
          onset={item.onset}
          offset={item.offset}
          fontSize={fontSize}
          lineHeight={lineHeight}
          jump={jump}
          scaleTo={scaleTo}
          palette={palette}
          glowColor={glow}
          glowRadius={glowRadius}
          withGlow={withGlow}
        />
      ))}
    </View>
  )
})

/**
 * 时钟驱动：挂在歌词容器里一次即可。
 * 只订阅播放器的进度与播放状态（约 1 次/秒的重渲染，且本组件不渲染任何内容）。
 */
export const LyricClockSync = memo(() => {
  const { nowPlayTime } = useProgress()
  const isPlay = useIsPlay()
  const rate = useSettingValue('player.playbackRate') || 1
  useLyricClockDriver(nowPlayTime, isPlay, rate)
  return null
})

const styles = createStyle({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
  },
  char: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  layer: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
})
