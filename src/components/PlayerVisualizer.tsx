import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, View, type LayoutChangeEvent } from 'react-native'

import { useIsPlay } from '@/store/player/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { createStyle } from '@/utils/tools'
import { getVisualizer, isVisualizerSupported, setVisualizerEnabled } from '@/plugins/player/soundEffect/visualizer'

/**
 * 播放页可视化背景（照 lx-music-desktop 的取数方式，动态调得比桌面版柔和很多）。
 *
 * 取数：原生每帧给 0..255 的频段值（1024 点 FFT、dB [-100,-30]、帧间平滑 0.6）
 * 显示：柱高 = v/255 * 整体响度增益 * 视图高，整体响度走 ~0.9s 慢速平滑，
 *       所以不会出现"整片一起闪"；每根柱子再做 0.16s 上升 / 0.6s 回落的非对称平滑。
 *
 * 性能：每根柱子独立 View，只走 setNativeProps 改 height，不触发 React 重渲染；
 *      25fps（省电 12fps）；停播后跌到 0 再降到 2fps；切后台完全不取数。
 */

const MAX_HEIGHT_RATIO = 0.30 // 名义最大高度
const BAR_PITCH = 9 // 每根柱子名义宽度（dp），越宽 → 柱子越少越不晃眼
const MIN_BARS = 20
const MAX_BARS = 72
const GAP_RATIO = 0.24
const CONTAINER_OPACITY = 0.11 // 背景层，越低越不刺眼
const MIN_DELTA = 0.5 // 高度变化小于 0.5dp 就不下发
const FRAME_MS = 40 // 25fps
const FRAME_MS_POWER_SAVE = 84
const RISE_SECONDS = 0.16 // 涨上去的速度
const FALL_SECONDS = 0.6 // 回落速度（眼睛主要受不了这个太快）
const LOUDNESS_SECONDS = 0.9 // 整体响度增益的平滑时间
const LOUDNESS_MIN = 0.62
const LOUDNESS_MAX = 1.25

export default memo(() => {
  const theme = useTheme()
  const isPlay = useIsPlay()
  const visualizerEnable = useSettingValue('player.visualizer.enable')
  const enable = visualizerEnable !== false
  const powerSaveMode = useSettingValue('common.powerSaveMode')
  const [size, setSize] = useState({ width: 0, height: 0 })

  const isPlayRef = useRef(isPlay)
  isPlayRef.current = isPlay

  const bars = useMemo(() => {
    if (!enable || !size.width) return 0
    return Math.max(MIN_BARS, Math.min(MAX_BARS, Math.round(size.width / BAR_PITCH)))
  }, [enable, size.width])

  const barWidth = bars ? size.width / bars : 0
  const maxHeight = size.height * MAX_HEIGHT_RATIO

  const barRefs = useMemo(() => new Array<View | null>(bars).fill(null), [bars])
  const heightsRef = useMemo(() => new Float64Array(bars), [bars])
  const appliedRef = useMemo(() => new Float64Array(bars), [bars])

  useEffect(() => {
    if (!enable || !isVisualizerSupported || !bars || !size.width || maxHeight <= 0) return
    const refs = barRefs
    const heights = heightsRef
    const applied = appliedRef
    const barCount = bars
    const maxH = maxHeight
    const target = new Float64Array(barCount)
    const smoothed = new Float64Array(barCount)
    setVisualizerEnabled(true)
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let idleFrames = 0
    let loudness = 0.85
    let lastAt = 0

    const applyFrame = (values: number[], active: boolean, deltaSeconds: number) => {
      // 1) 相邻柱子先做一次三点平滑，去掉宽频带带来的单根抽搐
      for (let i = 0; i < barCount; i++) {
        const center = (values[i] ?? 0) / 255
        const left = i > 0 ? (values[i - 1] ?? 0) / 255 : center
        const right = i < barCount - 1 ? (values[i + 1] ?? 0) / 255 : center
        smoothed[i] = active ? (left + center * 2 + right) * 0.25 : 0
        target[i] = smoothed[i]
      }
      // 2) 整体响度增益走慢速平滑：否则全场柱子会一起忽大忽小，看着像闪
      let sum = 0
      for (let i = 0; i < barCount; i++) sum += smoothed[i]
      const instant = barCount ? (sum / barCount) * 1.4 + 0.42 : 0.42
      const loudnessAlpha = 1 - Math.exp(-deltaSeconds / LOUDNESS_SECONDS)
      loudness += (Math.min(LOUDNESS_MAX, Math.max(LOUDNESS_MIN, instant)) - loudness) * loudnessAlpha

      // 3) 每根柱子按时间做非对称平滑（与帧率无关，省电模式下手感不变）
      const riseAlpha = 1 - Math.exp(-deltaSeconds / RISE_SECONDS)
      const fallAlpha = 1 - Math.exp(-deltaSeconds / FALL_SECONDS)
      for (let i = 0; i < barCount; i++) {
        const previous = heights[i]
        const wanted = target[i] * loudness * maxH
        const alpha = wanted > previous ? riseAlpha : fallAlpha
        const next = previous + (wanted - previous) * alpha
        heights[i] = next
        if (Math.abs(next - applied[i]) < MIN_DELTA) continue
        applied[i] = next
        refs[i]?.setNativeProps({ style: { height: next } })
      }
    }

    const tick = async() => {
      if (!alive) return
      if (AppState.currentState == 'background') {
        timer = setTimeout(tick, 800)
        return
      }
      const frame = await getVisualizer(barCount)
      if (!alive) return
      const now = Date.now()
      // 首次或长时间停摆时给一个稳定的 delta，避免一帧跳到底
      const deltaSeconds = lastAt ? Math.min(0.25, Math.max(0.008, (now - lastAt) / 1000)) : FRAME_MS / 1000
      lastAt = now
      const playing = (frame?.active ?? false) && isPlayRef.current
      if (frame) applyFrame(frame.bands, playing, deltaSeconds)
      idleFrames = playing ? 0 : idleFrames + 1
      timer = setTimeout(tick, idleFrames > 6 ? 500 : powerSaveMode ? FRAME_MS_POWER_SAVE : FRAME_MS)
    }

    timer = setTimeout(tick, 0)

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      setVisualizerEnabled(false)
      for (let i = 0; i < barCount; i++) {
        refs[i]?.setNativeProps({ style: { height: 0 } })
      }
      heights.fill(0)
      applied.fill(0)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enable, bars, size.width, maxHeight, powerSaveMode])

  const handleLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    setSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
  }

  // 注意：容器必须先渲染出来才能测到尺寸，所以这里不能因为 bars == 0 就返回 null
  if (!enable || !isVisualizerSupported) return null

  return (
    <View style={styles.container} pointerEvents="none" onLayout={handleLayout}>
      <View style={{ flex: 1, opacity: CONTAINER_OPACITY }}>
        {Array.from({ length: bars }, (_, index) => (
          <View
            key={index}
            ref={view => { barRefs[index] = view }}
            style={{
              position: 'absolute',
              left: index * barWidth,
              bottom: 0,
              width: Math.max(1, barWidth * (1 - GAP_RATIO)),
              height: 0,
              borderRadius: 1,
              backgroundColor: theme['c-primary'],
            }}
          />
        ))}
      </View>
    </View>
  )
})

const styles = createStyle({
  container: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  },
})
