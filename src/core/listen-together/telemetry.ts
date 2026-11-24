/**
 * 播放器遥测（源码级日志拦截，宪法第十一条）
 *
 * 目的：拿不到 ExoPlayer 的 Logcat 时，把播放器真实状态写进 App 自己的日志文件
 *      （src/utils/log.ts → temporaryDirectoryPath/error.log，设置页「查看日志」可读）。
 *
 * 记录内容：状态迁移、时长、位置、错误、以及“为什么没出声”的判定依据。
 */
import { log } from '@/utils/log'
import TrackPlayer from 'react-native-track-player'

const PREFIX = '[playback]'
let lastState = ''
let sampleTimer: ReturnType<typeof setInterval> | null = null

/** 播放状态迁移：Playing / Paused / None / Ended… */
export const logPlaybackState = (state: string, detail: Record<string, unknown> = {}): void => {
  state === lastState
    ? undefined
    : (() => {
        lastState = state
        log.info(`${PREFIX} state=${state} ${JSON.stringify(detail)}`)
      })()
}

/** 播放错误：连带把当前轨、时长、位置打出来，便于判定是 URL 被拒还是解码失败 */
export const logPlaybackError = async(error: unknown): Promise<void> => {
  const detail: Record<string, unknown> = {}
  try {
    detail.active = (await TrackPlayer.getActiveTrack()) as unknown
    detail.duration = await TrackPlayer.getDuration()
    detail.position = await TrackPlayer.getPosition()
  } catch (err) {
    detail.probeError = (err as Error).message
  }
  log.error(`${PREFIX} error=${(error as Error)?.message ?? String(error)} ${JSON.stringify(detail)}`)
}

/** 采样器：播放中每 2 秒记一次 duration/position，用来证明“真的在出声” */
export const startPlaybackSampling = (): void => {
  sampleTimer
    ? undefined
    : (sampleTimer = setInterval(() => {
    void (async() => {
      try {
        const duration = await TrackPlayer.getDuration()
        const position = await TrackPlayer.getPosition()
        const state = await TrackPlayer.getPlaybackState()
        log.info(`${PREFIX} sample duration=${(duration ?? 0).toFixed(2)}s position=${(position ?? 0).toFixed(2)}s state=${String((state as { state?: unknown })?.state ?? '?')}`)
      } catch (error) {
        log.warn(`${PREFIX} sample failed ${(error as Error).message}`)
      }
    })()
  }, 2000))
}

export const stopPlaybackSampling = (): void => {
  sampleTimer && (clearInterval(sampleTimer), (sampleTimer = null))
}

/** 播放前自检：给定 URL，验证它对 ExoPlayer 是否可播（写入日志，供人查看） */
export const logMediaProbe = (url: string, result: { ok: boolean, status: number, bytes: number, type: string }): void => {
  log.info(`${PREFIX} probe ok=${result.ok} http=${result.status} bytes=${result.bytes} type=${result.type} url=${url.slice(0, 120)}`)
}
