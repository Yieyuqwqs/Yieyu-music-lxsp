import { useEffect, useState } from 'react'
import BackgroundTimer from 'react-native-background-timer'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'

type Hook = (time: number, isPlayedStop: boolean) => void

const FADE_STEPS_PER_SEC = 4

/**
 * 懒加载设置音量：timeoutExit 若在模块顶层 import @/plugins/player，
 * 在冷启动/热重载的顺序里会拿到 undefined 的模块对象（真机报
 * "Cannot read property 'onTimeUpdate' of undefined"），改成调用时再取。
 */
/** 同样懒加载：core/common 是模块枢纽，顶层 import 会把玩家侧拖进循环依赖 */
const exitAppSafely = (reason: string) => {
  try {
    const common = require('@/core/common') as { exitApp?: (reason: string) => unknown }
    void common?.exitApp?.(reason)
  } catch (error) {
    console.warn('exitApp unavailable', error)
  }
}

const applyVolume = (volume: number) => {
  try {
    const player = require('@/plugins/player') as { setVolume?: (value: number) => unknown }
    void player?.setVolume?.(volume)
  } catch {}
}

const targetVolume = () => settingState.setting['player.volume'] ?? 1

const timeoutTools = {
  bgTimeout: null as number | null,
  timeout: null as ReturnType<typeof setInterval> | null,
  fadeTimeout: null as number | null,
  fadeInterval: null as number | null,
  startTime: 0,
  time: -1,
  timeHooks: [] as Hook[],
  exit() {
    if (settingState.setting['player.timeoutExitPlayed'] && playerState.isPlay) {
      global.lx.isPlayedStop = true
      applyVolume(0)
      this.callHooks()
      // 暂停后把音量放回去，否则下次点播放是静音的
      BackgroundTimer.setTimeout(() => { applyVolume(targetVolume()) }, 800)
    } else {
      exitAppSafely('Timeout Exit')
    }
  },
  /** 到点前 N 秒开始渐弱：二次曲线，越到后面掉得越快，听感自然 */
  startFade(seconds: number) {
    this.stopFade(false)
    const steps = Math.max(4, Math.round(seconds * FADE_STEPS_PER_SEC))
    const base = targetVolume()
    let step = 0
    this.fadeInterval = BackgroundTimer.setInterval(() => {
      step += 1
      const remain = Math.max(0, 1 - step / steps)
      applyVolume(base * remain * remain)
      if (step < steps) return
      if (this.fadeInterval != null) BackgroundTimer.clearInterval(this.fadeInterval)
      this.fadeInterval = null
    }, Math.round(1000 / FADE_STEPS_PER_SEC))
  },
  stopFade(restore: boolean) {
    if (this.fadeTimeout != null) {
      BackgroundTimer.clearTimeout(this.fadeTimeout)
      this.fadeTimeout = null
    }
    if (this.fadeInterval != null) {
      BackgroundTimer.clearInterval(this.fadeInterval)
      this.fadeInterval = null
    }
    if (restore) applyVolume(targetVolume())
  },
  getTime() {
    return Math.max(this.time - Math.round((performance.now() - this.startTime) / 1000), -1)
  },
  callHooks() {
    const time = this.getTime()
    for (const hook of this.timeHooks) {
      hook(time, global.lx.isPlayedStop)
    }
  },
  clearTimeout(restore = true) {
    if (this.bgTimeout != null) {
      BackgroundTimer.clearTimeout(this.bgTimeout)
      this.bgTimeout = null
    }
    if (this.timeout != null) {
      clearInterval(this.timeout)
      this.timeout = null
    }
    this.stopFade(restore)
    this.time = -1
    this.callHooks()
  },
  start(time: number) {
    this.clearTimeout()
    this.time = time
    this.startTime = performance.now()
    const fade = settingState.setting['player.timeoutExitFade'] ?? 0
    if (fade > 0 && fade < time) {
      this.fadeTimeout = BackgroundTimer.setTimeout(() => {
        this.fadeTimeout = null
        this.startFade(fade)
      }, Math.round((time - fade) * 1000))
    }
    this.bgTimeout = BackgroundTimer.setTimeout(() => {
      // 渐弱已经压到 0，这里不要再把音量放回去（否则暂停前会“回魂”一下）
      this.clearTimeout(false)
      this.exit()
    }, Math.round(time * 1000))
    this.timeout = setInterval(() => {
      this.callHooks()
    }, 1000)
  },
  addTimeHook(hook: Hook) {
    this.timeHooks.push(hook)
    hook(this.getTime(), global.lx.isPlayedStop)
  },
  removeTimeHook(hook: Hook) {
    this.timeHooks.splice(this.timeHooks.indexOf(hook), 1)
  },
}


export const startTimeoutExit = (time: number) => {
  timeoutTools.start(time)
}
export const stopTimeoutExit = () => {
  timeoutTools.clearTimeout()
}

export const getTimeoutExitTime = () => {
  return timeoutTools.time
}

export const useTimeoutExitTimeInfo = () => {
  const [info, setInfo] = useState({ time: 0, isPlayedStop: false })
  useEffect(() => {
    const hook: Hook = (time, isPlayedStop) => {
      setInfo({ time, isPlayedStop })
    }
    timeoutTools.addTimeHook(hook)
    return () => { timeoutTools.removeTimeHook(hook) }
  }, [setInfo])

  return info
}

export const onTimeUpdate = (handler: Hook) => {
  if (typeof handler !== 'function') return () => {}
  timeoutTools.addTimeHook(handler)

  return () => {
    timeoutTools.removeTimeHook(handler)
  }
}


export const cancelTimeoutExit = () => {
  global.lx.isPlayedStop = false
  timeoutTools.callHooks()
}
