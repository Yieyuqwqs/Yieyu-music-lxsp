/**
 * 高精度时钟（优先用 native 的 CLOCK_MONOTONIC，拿不到就退回 JS）
 *
 * 一起听的精度就靠它：单调时钟不受系统校时/改时间影响，
 * 用它算「从收到状态到现在过了多久」，比两台设备各算各的 epoch 差值严谨得多。
 */
import { NativeModules } from 'react-native'

interface ClockModule {
  nowMonotonicNs?: () => Promise<number>
  nowEpochMs?: () => Promise<number>
}

const native = (NativeModules as { YieyuCore?: ClockModule }).YieyuCore

export const isNativeClockAvailable = (): boolean => typeof native?.nowMonotonicNs === 'function'

/** 单调时间基准（毫秒）。首次调用时采样一次，之后用 JS 的 performance/Date 做增量，避免每次跨桥。 */
let baseMonotonicMs = 0
let baseJsMs = 0
let ready = false

const jsNow = (): number => {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance
  if (perf?.now) return perf.now()
  return Date.now()
}

/** 异步预热一次 native 基准（应用启动后调一次即可） */
export const primeClock = async(): Promise<void> => {
  if (ready || !native?.nowMonotonicNs) return
  try {
    const [ns, epoch] = await Promise.all([
      native.nowMonotonicNs(),
      native.nowEpochMs ? native.nowEpochMs() : Promise.resolve(Date.now()),
    ])
    baseMonotonicMs = Number(ns) / 1e6
    baseJsMs = jsNow()
    // 记一下 epoch 基准，方便日志和 UI
    epochBase = Number(epoch) || Date.now()
    ready = true
  } catch (error) {
    ready = false
  }
}

let epochBase = 0

/** 单调毫秒（不会倒退） */
export const monotonicMs = (): number => {
  if (ready) return baseMonotonicMs + (jsNow() - baseJsMs)
  return jsNow()
}

/** 墙钟毫秒（仅展示/日志） */
export const epochMs = (): number => {
  if (ready && epochBase) return epochBase + (jsNow() - baseJsMs)
  return Date.now()
}
