import { NativeModules, Platform } from 'react-native'
import { useEffect, useState } from 'react'
import settingState from '@/store/setting/state'
import licenseState from '@/store/license/state'
import { isProInfo } from '@/store/license/hook'
import { normalizeSoundEffect } from './config'

export interface SoundEffectStats {
  frames: number
  channels: number
  rate: number
  mode: number
  strength: number
  prepared: boolean
  headTrackReady: boolean
  headTrackLoaded: boolean
  headTrackBackend: string
  headTrackError: string
  headset: boolean
  headTrackYaw: number
  headTrackPredict: number
  // 极客功能一：Hi-Res 本地插值升频
  hiresSupported: boolean
  hiresEnabled: boolean
  hiresTarget: number
  hiresOutputRate: number
  hiresInputRate: number
  hiresFrames: number
  hiresError: string
  // Aurora-15 冷链防抖：降级链的真实状态（UI 按它诚实显示运行值）
  hiresEffectiveTarget?: number
  hiresDegraded?: boolean
  hiresDegrades?: number
  hiresDegradeReason?: string
  hiresCooldownMs?: number
  // Aurora-27：31 段均衡器内核状态
  eq31Available?: boolean
  eqNative?: boolean
  eqBands?: number
  eqTrimDb?: number
  eqLiveBands?: number
  // Aurora-29：模拟黑胶 / 胆机
  vinylAvailable?: boolean
  vinylNative?: boolean
  vinylAmount?: number
  vinylOs?: number
  vinylDriveDb?: number
  vinylHissDb?: number
}

const native = NativeModules.SoundEffectModule as {
  configure: (config: ReturnType<typeof normalizeSoundEffect>) => Promise<void>
  getStats: () => Promise<SoundEffectStats>
  setHiRes?: (enable: boolean, targetRate: number) => void
} | undefined

/** 自检数据：frames 不涨说明 DSP 没进音频链路 */
export const getSoundEffectStats = async(): Promise<SoundEffectStats | null> => {
  if (!native?.getStats) return null
  try {
    return await native.getStats()
  } catch {
    return null
  }
}
export const isSoundEffectSupported = Platform.OS == 'android' && !!native
let initialized = false
let readyOnce = false
let generation = 0
let lastConfig = ''
let status: 'ready' | 'loading' | 'error' = 'ready'
const listeners = new Set<() => void>()

const setStatus = (value: typeof status) => {
  status = value
  listeners.forEach(listener => { listener() })
}

let applyTimer: ReturnType<typeof setTimeout> | null = null

/** 设置变化的连续回调合并成一次下发，避免高频 configure 打断音频线程 */
export const scheduleApplySoundEffect = () => {
  if (applyTimer != null) clearTimeout(applyTimer)
  applyTimer = setTimeout(() => {
    applyTimer = null
    void applySoundEffect()
  }, 120)
}

/** 只接受 48/96/192kHz 三档，其余归还 192kHz */
export const normalizeHiResTarget = (value: unknown): number => {
  const rate = Math.round(Number(value))
  return rate === 96000 || rate === 48000 ? rate : 192000
}

let lastHiRes = ''
/** 极客功能一：Hi-Res 本地插值升频（原生 C++ 重采样到 192kHz） */
export const applyHiRes = () => {
  if (!native?.setHiRes) return
  const enable = settingState.setting['player.hires.enable'] === true
  const target = normalizeHiResTarget(settingState.setting['player.hires.target'])
  const serialized = `${enable ? 1 : 0}:${target}`
  if (serialized == lastHiRes) return
  lastHiRes = serialized
  try {
    native.setHiRes(enable, target)
  } catch {
    lastHiRes = ''
  }
}

export const applySoundEffect = async() => {
  if (!isSoundEffectSupported || !native) return
  // 重低音震动独立于音效配置：开关/强度任何一次变化都要落到原生侧
  const hapticNative = native as unknown as { setHapticBass?: (enable: boolean, strength: number) => void }
  if (hapticNative.setHapticBass) {
    try {
      hapticNative.setHapticBass(
        settingState.setting['player.hapticBass.enable'] === true,
        (settingState.setting['player.hapticBass.strength'] ?? 65) / 100,
      )
    } catch {}
  }
  applyHiRes()
  const config = normalizeSoundEffect(settingState.setting)
  // 蝰蛇（4）为会员音效：未激活时降级为「沉浸」，避免旧设置直接放行
  if (config.surroundMode === 4 && !isProInfo(licenseState)) config.surroundMode = 2
  const serialized = JSON.stringify(config)
  if (serialized == lastConfig && status != 'error') return
  lastConfig = serialized
  const current = ++generation
  // 只有第一次（内核还没就绪）才显示 loading：之后再刷状态会让面板高度抖一下
  if (!readyOnce) setStatus('loading')
  try {
    await native.configure(config)
    if (current == generation) {
      readyOnce = true
      setStatus('ready')
    }
  } catch (error) {
    if (current != generation) return
    console.error('Sound effect configuration failed', error)
    setStatus('error')
  }
}

export const initSoundEffect = async() => {
  if (!initialized && isSoundEffectSupported) {
    initialized = true
    global.state_event.on('configUpdated', keys => {
      if (keys.some(key => (key.startsWith('player.soundEffect.') && key != 'player.soundEffect.presets') || key.startsWith('player.hapticBass') || key.startsWith('player.hires.'))) scheduleApplySoundEffect()
    })
  }
  await applySoundEffect()
}

export const useSoundEffectStatus = () => {
  const [value, setValue] = useState(status)
  useEffect(() => {
    const listener = () => { setValue(status) }
    listeners.add(listener)
    listener()
    return () => { listeners.delete(listener) }
  }, [])
  return value
}

/** v1.9.1 的 store 只有 useSettingValue，这里用 configUpdated 事件做一个整包订阅 */
export const useSoundEffectConfig = () => {
  const [config, setConfig] = useState(() => normalizeSoundEffect(settingState.setting))
  useEffect(() => {
    const handle = (keys: string[]) => {
      if (keys.some(key => key.startsWith('player.soundEffect.') && key != 'player.soundEffect.presets')) {
        setConfig(normalizeSoundEffect(settingState.setting))
      }
    }
    global.state_event.on('configUpdated', handle)
    return () => { global.state_event.off('configUpdated', handle) }
  }, [])
  return config
}
