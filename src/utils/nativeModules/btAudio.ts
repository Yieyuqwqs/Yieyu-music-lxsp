// 蓝牙输出状态（只读）—— JS 包装层
//
// 说明：Android 没有公开 API 能读到/设置 A2DP 编码器（getCodecStatus / setCodecConfigPreference
// 都是 @SystemApi，需要 BLUETOOTH_PRIVILEGED），所以这里只做两件 App 真正能做的事：
//   ① 判断当前输出是不是蓝牙耳机在出声（没有任何权限要求）；
//   ② 提供一个跳「开发者选项」的入口，让用户自己选 LDAC / aptX 等编码器。
// 本文件不参与音频处理，也不读写播放器。

import { DeviceEventEmitter, NativeModules } from 'react-native'

export interface BtAudioState {
  /** 当前是否有蓝牙音频输出设备在链路上 */
  connected: boolean
  /** 设备名（可能为空字符串） */
  name: string
  /** 'a2dp' | 'sco' | '' */
  type: string
}

interface BtAudioNativeModule {
  getState: () => Promise<BtAudioState>
  openDeveloperOptions: () => Promise<boolean>
}

const mod = NativeModules.BtAudioModule as BtAudioNativeModule | undefined

const EMPTY: BtAudioState = { connected: false, name: '', type: '' }

export const getBtAudioState = async(): Promise<BtAudioState> => {
  if (!mod) return EMPTY
  try {
    const state = await mod.getState()
    return {
      connected: state?.connected === true,
      name: typeof state?.name === 'string' ? state.name : '',
      type: typeof state?.type === 'string' ? state.type : '',
    }
  } catch {
    return EMPTY
  }
}

/** 打开系统「开发者选项」，用户可在里面改蓝牙音频编解码器 */
export const openDeveloperOptions = async(): Promise<boolean> => {
  if (!mod) return false
  try {
    return await mod.openDeveloperOptions() === true
  } catch {
    return false
  }
}

/** 订阅蓝牙输出变化（插入/断开耳机） */
export const onBtAudioChanged = (listener: (state: BtAudioState) => void) => {
  const sub = DeviceEventEmitter.addListener('YieyuBtAudioChanged', (state: BtAudioState) => {
    listener({
      connected: state?.connected === true,
      name: typeof state?.name === 'string' ? state.name : '',
      type: typeof state?.type === 'string' ? state.type : '',
    })
  })
  return () => { sub.remove() }
}
