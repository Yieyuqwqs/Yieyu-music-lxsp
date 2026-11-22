// 星光跳动 · 全局节拍器（UI 线程时钟）
//
// 性能红线：逐字跳动、星光光晕一律不许用 JS setState 驱动。
// 做法（JS 线程在播放期间完全不参与动画）：
//   ① 播放进度回调（约 1s 一次，来自 playProgress 的原生 getPosition 轮询）只写一次共享值；
//   ② 两次回调之间由 useFrameCallback 在 UI 线程按真实帧间隔推进时钟，音画不脱节；
//   ③ 每个字的激活判定 / 弹簧位移 / 光晕透明度全部在 UI 线程用 useAnimatedStyle + withSpring 计算。
//
// 本文件只做时间搬运，不接触播放器、不接触音频管线：驱动时钟的输入永远是
// 播放器已经算好的 nowPlayTime 与 isPlay 两个只读状态。

import { useEffect } from 'react'
import { makeMutable, type SharedValue, useFrameCallback } from 'react-native-reanimated'

/** 掉帧 / 切后台回来时，单帧最多推进 100ms，防止时钟一次跳太远 */
const MAX_FRAME_STEP = 0.1
/** 进度与本地时钟偏差超过这个值才硬校准（seek / 切歌 / 暂停恢复） */
const HARD_SYNC_DRIFT = 0.4
/** 兜底校准周期：长时间不校准会累积漂移 */
const HARD_SYNC_PERIOD = 10000

interface LyricClockStore {
  /** 当前播放时间（秒），UI 线程共享 */
  clock: SharedValue<number>
  /** 是否正在播放 */
  playing: SharedValue<boolean>
  /** 播放倍速（进度是真实时间，时钟要按倍速推进才对得上） */
  rate: SharedValue<number>
  lastSyncAt: number
}

let store: LyricClockStore | null = null
/** 上一次进度回调的播放时间（秒），用来判断「进度是不是在往前走」 */
let lastSyncTime = -1

/**
 * 惰性创建共享值：不在模块导入阶段碰 reanimated 的 UI 运行时，
 * 只有播放页歌词真正挂载时才初始化（歌词页以外零开销、零风险）。
 */
export const getLyricClock = (): LyricClockStore => {
  if (!store) {
    store = {
      clock: makeMutable(0),
      playing: makeMutable(false),
      rate: makeMutable(1),
      lastSyncAt: 0,
    }
  }
  return store
}

/**
 * 播放进度回调 → 校准共享时钟。
 * 只在偏差较大时硬校准，其余时间让本地时钟自己按真实帧间隔走，避免每秒回拉抖动。
 */
export const syncLyricClock = (time: number, playing: boolean, rate = 1) => {
  const s = getLyricClock()
  const safe = Number.isFinite(time) && time > 0 ? time : 0
  // 自愈：就算外部 isPlay 状态没更新，只要进度在往前走就按时钟推进（防止动效整屏冻住）
  const advanced = lastSyncTime >= 0 && safe > lastSyncTime + 0.001
  lastSyncTime = safe
  s.rate.value = rate > 0 ? rate : 1
  s.playing.value = playing || advanced
  const drift = Math.abs(s.clock.value - safe)
  if (!s.playing.value || drift > HARD_SYNC_DRIFT || Date.now() - s.lastSyncAt > HARD_SYNC_PERIOD) {
    s.clock.value = safe
    s.lastSyncAt = Date.now()
  }
}

/** 暂停 / 切歌 / 拖进度条时立即对齐 */
export const resetLyricClock = (time: number) => {
  const s = getLyricClock()
  s.clock.value = Number.isFinite(time) && time > 0 ? time : 0
  s.lastSyncAt = Date.now()
}

/**
 * 挂一次：把共享时钟接到播放器状态上。
 * @param nowPlayTime 播放器当前时间（秒）
 * @param isPlay 是否播放中
 * @param rate 播放倍速
 */
export const useLyricClockDriver = (nowPlayTime: number, isPlay: boolean, rate = 1) => {
  useEffect(() => {
    syncLyricClock(nowPlayTime, isPlay, rate)
  }, [nowPlayTime, isPlay, rate])

  useFrameCallback((info) => {
    'worklet'
    if (!store || !store.playing.value) return
    const dt = info.timeSincePreviousFrame
    if (!dt || dt <= 0) return
    store.clock.value += Math.min(dt / 1000, MAX_FRAME_STEP) * store.rate.value
  }, true)
}
