import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, PanResponder, StyleSheet, View } from 'react-native'

import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { usePlayerMusicInfo } from '@/store/player/hook'
import { useWindowSize } from '@/utils/hooks'
import { NAV_SHEAR_NATIVE_IDS } from '@/config/constant'
import { useNavigationComponentDidAppear } from '@/navigation'
import { useSettingValue } from '@/store/setting/hook'
import { playNext, playPrev, togglePlay } from '@/core/player/player'
import commonState from '@/store/common/state'


export default ({ componentId, onShowLyricPage }: { componentId: string, onShowLyricPage?: () => void }) => {
  const musicInfo = usePlayerMusicInfo()
  const { width: winWidth, height: winHeight } = useWindowSize()
  const gestureEnable = useSettingValue('playDetail.gestureEnable')
  const isDiscRotate = useSettingValue('playDetail.isDiscRotate')

  const [animated, setAnimated] = useState(!!commonState.componentIds.playDetail)
  const [pic, setPic] = useState(musicInfo.pic)
  useEffect(() => {
    if (animated) setPic(musicInfo.pic)
  }, [musicInfo.pic, animated])

  useNavigationComponentDidAppear(componentId, () => {
    setAnimated(true)
  })

  const rotateValue = useRef(new Animated.Value(0)).current
  const rotateAnim = useRef<Animated.CompositeAnimation | null>(null)
  useEffect(() => {
    // 圆角矩形封面不做旋转，避免视觉割裂（保留设置项但仅对圆形生效已无意义，这里直接不旋转）
    rotateAnim.current?.stop()
    rotateValue.setValue(0)
  }, [isDiscRotate, rotateValue])

  // 手势：单击→歌词页、双击→播放/暂停、左右滑→切歌
  const lastTapRef = useRef(0)
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current)
  }, [])
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => gestureEnable,
    onMoveShouldSetPanResponder: (evt, gestureState) => gestureEnable && Math.abs(gestureState.dx) > 24 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (evt, gestureState) => {
      if (!gestureEnable) return
      const { dx, dy } = gestureState
      if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (singleTapTimerRef.current) {
          clearTimeout(singleTapTimerRef.current)
          singleTapTimerRef.current = null
        }
        if (dx < 0) void playNext()
        else void playPrev()
        return
      }
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        const now = Date.now()
        if (now - lastTapRef.current < 200) {
          if (singleTapTimerRef.current) {
            clearTimeout(singleTapTimerRef.current)
            singleTapTimerRef.current = null
          }
          lastTapRef.current = 0
          togglePlay()
        } else {
          lastTapRef.current = now
          singleTapTimerRef.current = setTimeout(() => {
            singleTapTimerRef.current = null
            lastTapRef.current = 0
            onShowLyricPage?.()
          }, 200)
        }
      }
    },
  }), [gestureEnable, onShowLyricPage])

  const coverSize = useMemo(() => Math.min(winWidth * 0.8, (winHeight - 220) * 0.62), [winHeight, winWidth])

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      <View style={styles.titleContent}>
        <Text size={24} color="#ffffff" numberOfLines={1} style={styles.title}>{musicInfo.name || '—'}</Text>
        <Text size={14} color="rgba(255,255,255,0.6)" numberOfLines={1} style={styles.singer}>{musicInfo.singer || ''}</Text>
      </View>
      <View style={styles.coverWrap}>
        <View style={[styles.coverShadow, { width: coverSize, height: coverSize }]}>
          <Image
            url={pic}
            nativeID={NAV_SHEAR_NATIVE_IDS.playDetail_pic}
            style={[styles.cover, { width: coverSize, height: coverSize }]}
            resizeMode="cover"
          />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    flexShrink: 1,
    paddingTop: 10,
    alignItems: 'center',
  },
  titleContent: {
    width: '100%',
    paddingHorizontal: 24,
    alignItems: 'center',
    marginBottom: 18,
  },
  title: {
    fontWeight: '700',
    textAlign: 'center',
  },
  singer: {
    marginTop: 6,
    textAlign: 'center',
  },
  coverWrap: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  coverShadow: {
    borderRadius: 20,
    elevation: 20,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 20 },
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  cover: {
    borderRadius: 20,
    overflow: 'hidden',
  },
})
