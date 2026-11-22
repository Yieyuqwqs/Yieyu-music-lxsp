import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Easing, PanResponder, Pressable, StyleSheet, View } from 'react-native'

import Text from '@/components/common/Text'
import Image from '@/components/common/Image'
import { Icon } from '@/components/common/Icon'
import { useIsPlay, usePlayMusicInfo, usePlayerMusicInfo, useProgress } from '@/store/player/hook'
import { useMusicExistsList } from '@/store/list/hook'
import { MUSIC_TOGGLE_MODE, MUSIC_TOGGLE_MODE_LIST, LIST_IDS } from '@/config/constant'
import { collectMusic, playNext, playPrev, togglePlay, uncollectMusic } from '@/core/player/player'
import { useLrcPlay, useLrcSet } from '@/plugins/lyric'
import { useWindowSize, useDrag } from '@/utils/hooks'
import { useStatusbarHeight } from '@/store/common/hook'
import { useSettingValue } from '@/store/setting/hook'
import { useTheme } from '@/store/theme/hook'
import { useI18n } from '@/lang'
import { updateSetting } from '@/core/common'
import { toast } from '@/utils/tools'
import { navigations } from '@/navigation'
import commonState from '@/store/common/state'

const LOVE_LIST = { id: LIST_IDS.LOVE } as unknown as LX.List.MyListInfo

const ProgressBar = ({ progress, duration }: { progress: number, duration: number }) => {
  const theme = useTheme()
  const [dragging, setDragging] = useState(false)
  const [dragProgress, setDragProgress] = useState(0)
  const durationRef = useRef(duration)
  durationRef.current = duration
  const onSetProgress = (value: number) => {
    global.app_event.setProgress(value * durationRef.current)
  }
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

  const shown = Math.max(0, Math.min(1, dragging ? dragProgress : progress)) * 100

  return (
    <View style={styles.barArea} onLayout={onLayout} {...panResponder.panHandlers}>
      <View style={styles.bar}>
        <View style={{ ...styles.barFill, width: `${shown}%`, backgroundColor: theme['c-primary'] }} />
        <View style={{ ...styles.barThumb, left: `${shown}%` }} />
      </View>
    </View>
  )
}

export default memo(({ onShowLyricPage }: { onShowLyricPage?: () => void }) => {
  const { width: winWidth } = useWindowSize()
  const statusBarHeight = useStatusbarHeight()
  const musicInfo = usePlayerMusicInfo()
  const playMusicInfo = usePlayMusicInfo()
  const isPlay = useIsPlay()
  const gestureEnable = useSettingValue('playDetail.gestureEnable')
  const togglePlayMethod = useSettingValue('player.togglePlayMethod')
  const { progress, maxPlayTime, nowPlayTimeStr, maxPlayTimeStr } = useProgress()
  const { line } = useLrcPlay()
  const lines = useLrcSet()
  const isLove = useMusicExistsList(LOVE_LIST, (playMusicInfo.musicInfo ?? { id: '' }) as LX.Music.MusicInfo)
  const t = useI18n()
  const theme = useTheme()

  const recordSize = Math.min(260, winWidth * 0.66)
  const artSize = recordSize - 30

  // 黑胶旋转
  const rotateValue = useRef(new Animated.Value(0)).current
  useEffect(() => {
    let stopped = false
    const run = () => {
      if (stopped) return
      rotateValue.setValue(0)
      Animated.timing(rotateValue, {
        toValue: 1,
        duration: 20000,
        easing: Easing.linear,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) run()
      })
    }
    if (isPlay) run()
    else rotateValue.stopAnimation()
    return () => {
      stopped = true
      rotateValue.stopAnimation()
    }
  }, [isPlay, rotateValue])
  const rotate = rotateValue.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] })

  // 手势
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

  // 三行歌词
  const lyricLines = useMemo(() => {
    if (!lines.length) return [{ text: '' }, { text: '' }, { text: '' }]
    const current = Math.max(0, Math.min(line, lines.length - 1))
    return [lines[current - 1], lines[current], lines[current + 1]].map(item => ({ text: item?.text ?? '' }))
  }, [line, lines])

  const playModeIcon = useMemo(() => {
    switch (togglePlayMethod) {
      case MUSIC_TOGGLE_MODE.listLoop: return 'list-loop'
      case MUSIC_TOGGLE_MODE.random: return 'list-random'
      case MUSIC_TOGGLE_MODE.list: return 'list-order'
      case MUSIC_TOGGLE_MODE.singleLoop: return 'single-loop'
      default: return 'list-order'
    }
  }, [togglePlayMethod])

  const handleToggleMode = () => {
    let index = MUSIC_TOGGLE_MODE_LIST.indexOf(togglePlayMethod)
    if (++index >= MUSIC_TOGGLE_MODE_LIST.length) index = 0
    const mode = MUSIC_TOGGLE_MODE_LIST[index]
    updateSetting({ 'player.togglePlayMethod': mode })
    const names = {
      [MUSIC_TOGGLE_MODE.listLoop]: 'play_list_loop',
      [MUSIC_TOGGLE_MODE.random]: 'play_list_random',
      [MUSIC_TOGGLE_MODE.list]: 'play_list_order',
      [MUSIC_TOGGLE_MODE.singleLoop]: 'play_single_loop',
      [MUSIC_TOGGLE_MODE.none]: 'play_single',
    }
    toast(t(names[mode] as never))
  }

  return (
    <View style={styles.container}>
      <View style={styles.centerWrap}>
      <View style={{ ...styles.centerStage, marginTop: statusBarHeight * 0 + 4 }}>
        <View style={styles.vinylOuter} {...panResponder.panHandlers}>
          <View style={{ ...styles.vinyl, width: recordSize, height: recordSize, borderRadius: recordSize / 2 }}>
            <View style={[styles.vinylRing, { borderRadius: recordSize / 2 }]} />
            <Animated.View style={{ width: artSize, height: artSize, borderRadius: artSize / 2, transform: [{ rotate }] }}>
              <Image url={musicInfo.pic} style={{ width: '100%', height: '100%', borderRadius: artSize / 2 }} />
            </Animated.View>
          </View>
        </View>
        <View style={styles.lyrics}>
          {
            lyricLines.map((item, index) => (
              <Text
                key={index}
                numberOfLines={1}
                size={index == 1 ? 16 : 14}
                color={index == 1 ? '#ffffff' : 'rgba(255,255,255,0.4)'}
                style={[styles.lyricLine, index == 1 && styles.lyricActive]}
              >
                {item.text}
              </Text>
            ))
          }
        </View>
      </View>
      </View>

      <View style={styles.bottomPanel}>
        <View style={styles.progressBox}>
          <Text size={12} color="rgba(255,255,255,0.6)" style={styles.time}>{nowPlayTimeStr}</Text>
          <ProgressBar progress={progress} duration={maxPlayTime} />
          <Text size={12} color="rgba(255,255,255,0.6)" style={styles.time}>{maxPlayTimeStr}</Text>
        </View>

        <View style={styles.mainControls}>
          <Pressable style={({ pressed }) => [styles.ctrlIcon, pressed && styles.pressed]} hitSlop={10} onPress={() => { void playPrev() }}>
            <Icon name="prevMusic" color="rgba(255,255,255,0.9)" size={34} />
          </Pressable>
          <Pressable style={({ pressed }) => [styles.playBtn, pressed && styles.pressed]} onPress={togglePlay}>
            <Icon name={isPlay ? 'pause' : 'play'} color="#ffffff" size={30} />
          </Pressable>
          <Pressable style={({ pressed }) => [styles.ctrlIcon, pressed && styles.pressed]} hitSlop={10} onPress={() => { void playNext() }}>
            <Icon name="nextMusic" color="rgba(255,255,255,0.9)" size={34} />
          </Pressable>
        </View>

        <View style={styles.subControls}>
          <Pressable hitSlop={8} onPress={() => { onShowLyricPage?.() }}>
            <Text size={13} color="rgba(255,255,255,0.7)" style={styles.lrcText}>LRC</Text>
          </Pressable>
          <Pressable style={({ pressed }) => [pressed && styles.pressed]} hitSlop={8} onPress={() => {
            if (isLove) uncollectMusic()
            else collectMusic()
            toast(isLove ? t('list_uncollect') : t('collect_success'))
          }}>
            <Icon name="love" color={isLove ? '#ff5c8a' : 'rgba(255,255,255,0.7)'} size={24} />
          </Pressable>
          <Pressable style={({ pressed }) => [pressed && styles.pressed]} hitSlop={8} onPress={handleToggleMode}>
            <Icon name={playModeIcon} color="rgba(255,255,255,0.7)" size={24} />
          </Pressable>
          <Pressable style={({ pressed }) => [pressed && styles.pressed]} hitSlop={8} onPress={() => { navigations.pushCommentScreen(commonState.componentIds.playDetail!) }}>
            <Icon name="comment" color="rgba(255,255,255,0.7)" size={24} />
          </Pressable>
        </View>
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
  },
  centerWrap: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerStage: {
    alignItems: 'center',
    flexShrink: 0,
  },
  vinylOuter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  vinyl: {
    backgroundColor: '#111111',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 20,
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 25,
    shadowOffset: { width: 0, height: 25 },
  },
  vinylRing: {
    position: 'absolute',
    top: 2,
    left: 2,
    right: 2,
    bottom: 2,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  lyrics: {
    marginTop: 35,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lyricLine: {
    marginVertical: 4,
    textAlign: 'center',
  },
  lyricActive: {
    fontWeight: '600',
  },
  bottomPanel: {
    paddingHorizontal: 25,
    paddingBottom: 30,
  },
  progressBox: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 35,
  },
  time: {
    fontVariant: ['tabular-nums'],
  },
  barArea: {
    flex: 1,
    height: 28,
    marginHorizontal: 12,
    justifyContent: 'center',
  },
  bar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
  },
  barFill: {
    position: 'absolute',
    left: 0,
    height: '100%',
    borderRadius: 3,
  },
  barThumb: {
    position: 'absolute',
    width: 32,
    height: 16,
    marginLeft: -16,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 3,
  },
  mainControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 30,
  },
  ctrlIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 27,
  },
  playBtn: {
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    elevation: 6,
  },
  subControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 15,
  },
  lrcText: {
    letterSpacing: 1,
  },
  pressed: {
    transform: [{ scale: 0.9 }],
  },
})
