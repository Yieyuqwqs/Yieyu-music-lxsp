/**
 * 原生同步引擎的 JS 门面（C++ 核心见 android/.../p2p/sync_engine.cpp）
 *
 * 目的：把「锚点 + 播放头」的计算和定时放到原生，
 * 避开 JS 主线程卡顿带来的 10–50ms 抖动。拿不到原生就退回 JS 计算。
 */
import { DeviceEventEmitter, NativeModules } from 'react-native'
import { monotonicMs } from './clockrt'
import { reportError } from '@/core/listen-together/errors'

interface SyncModule {
  syncSetAnchor?: (positionMs: number, anchorMonoUs: number, playing: boolean) => Promise<boolean>
  syncPlayheadMs?: () => Promise<number>
  syncLeadMs?: () => Promise<number>
  syncNowUs?: () => Promise<number>
  syncSchedule?: (commandId: number, delayMs: number) => Promise<boolean>
  syncCancel?: (commandId: number) => Promise<boolean>
  syncClear?: () => Promise<boolean>
  syncSchedule?: (commandId: number, delayMs: number) => Promise<boolean>
  syncCancel?: (commandId: number) => Promise<boolean>
  syncStartPump?: () => Promise<boolean>
  syncStopPump?: () => Promise<boolean>
}

const native = (NativeModules as { YieyuCore?: SyncModule }).YieyuCore

export const isSyncEngineAvailable = (): boolean => typeof native?.syncSetAnchor === 'function'

/** 上一帧缓存的播放头，避免每帧都跨桥 */
let cachedPlayhead = 0
let cachedAt = 0

/**
 * 下发锚点。anchorServerMs 是服务端/房主时间，这里换算成单调时钟基准：
 *   anchorMonoUs = nowMono - (serverNow - anchorServerMs) * 1000
 */
export const pushAnchor = async(playback: { positionMs: number, anchorServerMs: number, isPlaying: boolean }, serverNow: number): Promise<void> => {
  if (!native?.syncSetAnchor) return
  try {
    const nowUs = native.syncNowUs ? await native.syncNowUs() : monotonicMs() * 1000
    const anchorMonoUs = nowUs - (serverNow - playback.anchorServerMs) * 1000
    await native.syncSetAnchor(Math.max(0, playback.positionMs), anchorMonoUs, playback.isPlaying)
  } catch (error) { reportError('sync:锚点下发', error) }
}

/** 当前播放头（毫秒）。原生不可用时用 JS 单调时钟算 */
export const syncPlayheadMs = (fallback: () => number): number => {
  if (native?.syncPlayheadMs) {
    // 异步取不到就返回上一帧缓存，保证 UI 不卡
    void native.syncPlayheadMs().then((value) => { cachedPlayhead = Number(value) || 0; cachedAt = Date.now() }).catch(() => {})
    if (Date.now() - cachedAt < 200) return cachedPlayhead
  }
  return fallback()
}

export const syncLeadMs = async(): Promise<number | null> => {
  if (!native?.syncLeadMs) return null
  try { return Number(await native.syncLeadMs()) } catch (error) { reportError('sync:读取提前量', error); return null }
}

export const syncClear = async(): Promise<void> => {
  if (!native?.syncClear) return
  try { await native.syncClear() } catch (error) { reportError('sync:清理', error) }
}


/** 原生定时：到点由 C++ 线程叫醒，JS 只负责执行（误差 <1ms，JS 定时器是 10–50ms） */
export const scheduleNative = async(commandId: number, delayMs: number): Promise<boolean> => {
  if (!native?.syncSchedule) return false
  try { return await native.syncSchedule(commandId, Math.max(0, Math.round(delayMs))) } catch (error) { reportError('sync:调度', error); return false }
}

export const cancelNative = async(commandId: number): Promise<void> => {
  if (!native?.syncCancel) return
  try { await native.syncCancel(commandId) } catch (error) { reportError('sync:取消', error) }
}

/** 订阅原生到点事件 */
export const startSyncPump = (handler: (commandId: number) => void): (() => void) => {
  if (!native?.syncStartPump) return () => {}
  const sub = DeviceEventEmitter.addListener('lxp2p:sync', (id: number) => {
    if (typeof id === 'number') handler(id)
  })
  void native.syncStartPump().catch(() => {})
  return () => {
    sub.remove()
    void native?.syncStopPump?.().catch(() => {})
  }
}
