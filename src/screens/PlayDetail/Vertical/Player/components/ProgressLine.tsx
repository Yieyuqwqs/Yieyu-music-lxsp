import { memo, useCallback, useRef, useState } from 'react'
import { PanResponder, View } from 'react-native'

import { useDrag } from '@/utils/hooks'
import { createStyle } from '@/utils/tools'

const BAR_HEIGHT = 3
const DOT_SIZE = 9

interface Props {
  progress: number
  duration: number
}

/**
 * 播放页进度条：3px、细白线、拖动时才显示圆点
 */
export default memo(({ progress, duration }: Props) => {
  const [dragging, setDragging] = useState(false)
  const [dragProgress, setDragProgress] = useState(0)
  const durationRef = useRef(duration)
  durationRef.current = duration
  const onSetProgress = useCallback((value: number) => {
    global.app_event.setProgress(value * durationRef.current)
  }, [])
  const { onLayout, onDragStart, onDragEnd, onDrag } = useDrag(onSetProgress, setDragging, setDragProgress)

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderGrant: (evt, gestureState) => {
      onDragStart(gestureState.dx, evt.nativeEvent.locationX)
    },
    onPanResponderMove: (evt, gestureState) => {
      onDrag(gestureState.dx)
    },
    onPanResponderRelease: () => {
      onDragEnd()
    },
    onPanResponderTerminate: () => {
      onDragEnd()
    },
  })).current

  const shown = dragging ? dragProgress : progress
  const width = Math.max(0, Math.min(1, shown)) * 100

  return (
    <View style={styles.container}>
      <View style={styles.track}>
        <View style={[styles.played, { width: `${width}%` }]}>
          {dragging ? <View style={styles.dot} /> : null}
        </View>
      </View>
      <View style={styles.pressArea} onLayout={onLayout} {...panResponder.panHandlers} />
    </View>
  )
})

const styles = createStyle({
  container: {
    width: '100%',
    height: 24,
    justifyContent: 'center',
  },
  track: {
    height: BAR_HEIGHT,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'visible',
  },
  played: {
    height: BAR_HEIGHT,
    borderRadius: 2,
    backgroundColor: '#ffffff',
  },
  dot: {
    position: 'absolute',
    right: -DOT_SIZE / 2,
    top: -(DOT_SIZE - BAR_HEIGHT) / 2,
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    backgroundColor: '#ffffff',
  },
  pressArea: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
})
