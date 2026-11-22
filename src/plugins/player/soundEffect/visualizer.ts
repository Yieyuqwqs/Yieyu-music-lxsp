import { NativeModules, Platform } from 'react-native'

export interface VisualizerFrame {
  /** 每根柱子的高度，0..255（对应桌面版 getByteFrequencyData 的输出） */
  bands: number[]
  /** 本次是否取到了新的音频数据；false 表示停播/无数据 */
  active: boolean
  rms: number
}

interface VisualizerNative {
  getVisualizer?: (count: number) => Promise<VisualizerFrame>
  setVisualizerEnabled?: (enabled: boolean) => void
}

const native = NativeModules.SoundEffectModule as VisualizerNative | undefined

/** 可视化依赖音效模块里挂的那段 PCM，模块不在就没有 */
export const isVisualizerSupported = Platform.OS == 'android' && !!native?.getVisualizer

export const setVisualizerEnabled = (enabled: boolean) => {
  try {
    native?.setVisualizerEnabled?.(enabled)
  } catch {}
}

export const getVisualizer = async(count: number): Promise<VisualizerFrame | null> => {
  if (!native?.getVisualizer) return null
  try {
    const frame = await native.getVisualizer(count)
    const bands = frame?.bands
    if (!Array.isArray(bands) || bands.length == 0) return null
    return { bands, active: frame.active !== false, rms: typeof frame.rms == 'number' ? frame.rms : 0 }
  } catch {
    return null
  }
}
