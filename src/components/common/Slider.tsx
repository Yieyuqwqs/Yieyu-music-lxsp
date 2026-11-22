import { memo, useCallback, useRef, useState } from 'react'
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native'

import { useTheme } from '@/store/theme/hook'

export type SliderProps = {
  value?: number
  minimumValue?: number
  maximumValue?: number
  onSlidingStart?: (value: number) => void
  onSlidingComplete?: (value: number) => void
  onValueChange?: (value: number) => void
  step?: number
  accessibilityLabel?: string
  disabled?: boolean
}

const TRACK_HEIGHT = 8
const THUMB_WIDTH = 22
const THUMB_HEIGHT = 12
const EPSILON = 1e-6

const roundValue = (value: number) => Math.round(value / EPSILON) * EPSILON

/**
 * 胶囊风格滑块：粗底槽 + 白色胶囊滑块
 *
 * 关键点（抖动/跳变的根因都在这里）：
 * - 用 pageX + 容器实测偏移换算数值。locationX 是「相对当前触摸目标」的坐标，
 *   拖过填充条/滑块头时目标会变，数值就会突然跳（还会 100→99）
 * - 拖动只回报 onValueChange（前端临时值），松手才回报 onSlidingComplete
 * - 回调全部走 ref，避免 PanResponder 闭包读到旧回调
 * - 两端按半个滑块留白映射，保证拖到最右就是最大值的精确值
 */
export default memo(({
  value = 0,
  minimumValue = 0,
  maximumValue = 1,
  onSlidingStart,
  onSlidingComplete,
  onValueChange,
  step,
  accessibilityLabel,
  disabled = false,
}: SliderProps) => {
  const theme = useTheme()
  const [width, setWidth] = useState(0)
  const [dragValue, setDragValue] = useState<number | null>(null)

  const containerRef = useRef<View>(null)
  const widthRef = useRef(0)
  const offsetRef = useRef(0)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const rangeRef = useRef({ min: minimumValue, max: maximumValue, step })
  rangeRef.current = { min: minimumValue, max: maximumValue, step }
  const valueRef = useRef(value)
  valueRef.current = value
  const dragValueRef = useRef<number | null>(null)
  const measuredRef = useRef(false)

  const onChangeRef = useRef(onValueChange)
  onChangeRef.current = onValueChange
  const onStartRef = useRef(onSlidingStart)
  onStartRef.current = onSlidingStart
  const onCompleteRef = useRef(onSlidingComplete)
  onCompleteRef.current = onSlidingComplete

  const measure = useCallback(() => {
    const node = containerRef.current
    if (!node) return
    node.measureInWindow((x, _y, w) => {
      if (typeof x === 'number') {
        offsetRef.current = x
        measuredRef.current = true
      }
      if (typeof w === 'number' && w > 1) {
        widthRef.current = w
        setWidth(w)
      }
    })
  }, [])

  // 按 step 吸附，并保证两端一定是精确的 min / max
  const snap = useCallback((raw: number) => {
    const { min, max, step: stepSize } = rangeRef.current
    let next = Number.isFinite(raw) ? raw : min
    if (next <= min) return roundValue(min)
    if (next >= max) return roundValue(max)
    if (stepSize && stepSize > 0) {
      const steps = Math.round((next - min) / stepSize)
      next = min + steps * stepSize
      if (next > max) next = max
      if (next < min) next = min
    }
    return roundValue(next)
  }, [])

  const valueFromPageX = useCallback((pageX: number) => {
    const { min, max } = rangeRef.current
    const w = widthRef.current
    if (!w) return roundValue(min)
    const usable = Math.max(1, w - THUMB_WIDTH)
    const rawRatio = (pageX - offsetRef.current - THUMB_WIDTH / 2) / usable
    const ratio = rawRatio <= 0 ? 0 : rawRatio >= 1 ? 1 : rawRatio
    return snap(min + (max - min) * ratio)
  }, [snap])

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !disabledRef.current,
    onStartShouldSetPanResponderCapture: () => !disabledRef.current,
    onMoveShouldSetPanResponder: () => !disabledRef.current,
    onMoveShouldSetPanResponderCapture: () => !disabledRef.current,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (evt) => {
      if (disabledRef.current) return
      measure()
      const next = valueFromPageX(evt.nativeEvent.pageX)
      dragValueRef.current = next
      setDragValue(next)
      onStartRef.current?.(next)
    },
    onPanResponderMove: (evt) => {
      if (disabledRef.current) return
      const next = valueFromPageX(evt.nativeEvent.pageX)
      if (dragValueRef.current !== null && Math.abs(dragValueRef.current - next) < EPSILON) return
      dragValueRef.current = next
      setDragValue(next)
      onChangeRef.current?.(next)
    },
    onPanResponderRelease: (evt) => {
      if (disabledRef.current) return
      const next = valueFromPageX(evt.nativeEvent.pageX)
      dragValueRef.current = null
      setDragValue(null)
      onCompleteRef.current?.(next)
    },
    onPanResponderTerminate: () => {
      const next = dragValueRef.current
      dragValueRef.current = null
      setDragValue(null)
      if (next !== null) onCompleteRef.current?.(next)
    },
  })).current

  const handleLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width
    widthRef.current = w
    setWidth(w)
    measure()
  }

  const { min, max } = rangeRef.current
  const shown = dragValue ?? valueRef.current
  const ratio = max === min ? 0 : Math.max(0, Math.min(1, (shown - min) / (max - min)))
  const usable = Math.max(1, width - THUMB_WIDTH)
  const fillWidth = `${ratio * 100}%` as const

  return (
    <View
      ref={containerRef}
      style={{ ...styles.container, opacity: disabled ? 0.4 : 1 }}
      onLayout={handleLayout}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="adjustable"
      accessibilityState={{ disabled }}
      {...panResponder.panHandlers}
    >
      <View style={[styles.track, { backgroundColor: theme['c-primary-alpha-200'] }]}>
        <View style={[styles.fill, { width: fillWidth, backgroundColor: theme['c-primary'] }]} />
      </View>
      {
        width > 0
          ? <View
              style={[
                styles.thumb,
                { left: Math.max(0, Math.min(width - THUMB_WIDTH, THUMB_WIDTH / 2 + ratio * usable - THUMB_WIDTH / 2)) },
              ]}
            />
          : null
      }
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    height: 34,
    justifyContent: 'center',
    flexGrow: 1,
    flexShrink: 1,
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    overflow: 'hidden',
  },
  fill: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
  },
  thumb: {
    position: 'absolute',
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    borderRadius: THUMB_HEIGHT / 2,
    backgroundColor: '#ffffff',
    top: (34 - THUMB_HEIGHT) / 2,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
})
