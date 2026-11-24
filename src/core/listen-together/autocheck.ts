/**
 * 播放链路自动核验（宪法第十二条：不把验证甩给人类）
 *
 * 机制：每首歌进入 Ready 后 3 秒，读一次 ExoPlayer 的 duration/position/state，
 *      把结果**自动写成机器可读文件**到共享存储 /sdcard/lxsp-autocheck.json，
 *      由 agent 自行读取判断——用户不需要看日志、不需要贴报告。
 */
import { writeFile } from '@/utils/fs'
import { externalStorageDirectoryPath } from '@/utils/fs'
import TrackPlayer from 'react-native-track-player'
import { log } from '@/utils/log'

const OUT_PATH = `${externalStorageDirectoryPath}/lxsp-autocheck.json`

interface CheckRecord {
  at: string
  seq: number
  durationMs: number
  positionMs: number
  state: string
  ok: boolean
}

const records: CheckRecord[] = []
let seq = 0
let pending: ReturnType<typeof setTimeout> | null = null

const flush = async(): Promise<void> => {
  try {
    await writeFile(OUT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), records }, null, 2))
    log.info(`[autocheck] wrote ${records.length} records → ${OUT_PATH}`)
  } catch (error) {
    log.warn(`[autocheck] write failed: ${(error as Error).message}`)
  }
}

/** Ready 事件后调用：3 秒后采样一次并落盘（每首歌一条） */
export const scheduleAutocheck = (label: string): void => {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    void (async() => {
      let durationMs = 0
      let positionMs = 0
      let state = 'unknown'
      try {
        durationMs = Math.round((await TrackPlayer.getDuration()) ?? 0)
        positionMs = Math.round((await TrackPlayer.getPosition()) ?? 0)
        state = String((await TrackPlayer.getPlaybackState() as { state?: unknown })?.state ?? '?')
      } catch (error) {
        state = `error:${(error as Error).message}`
      }
      seq += 1
      records.push({ at: new Date().toISOString(), seq, durationMs, positionMs, state, ok: durationMs > 0 })
      if (records.length > 20) records.shift()
      log.info(`[autocheck] #${seq} ${label} duration=${durationMs}ms position=${positionMs}ms state=${state} ok=${durationMs > 0}`)
      await flush()
    })()
  }, 3000)
}
