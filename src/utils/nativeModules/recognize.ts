import { NativeModules } from 'react-native'

const { RecognizeModule } = NativeModules

/**
 * 录制指定时长的麦克风音频，返回 PCM16 base64
 */
export const recordAudio = async(durationMs: number): Promise<string> => {
  if (!RecognizeModule?.record) throw new Error('record module not available')
  return RecognizeModule.record(durationMs)
}
