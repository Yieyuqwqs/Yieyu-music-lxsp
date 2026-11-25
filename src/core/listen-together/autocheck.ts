/**
 * 播放链路自动核验（宪法第十二条：不把验证甩给人类）
 *
 * 机制：每首歌进入 Ready 后 3 秒，读一次 ExoPlayer 的 duration/position/state，
 *      把结果**自动写成机器可读文件**到共享存储 /sdcard/lxsp-autocheck.json，
 *      由 agent 自行读取判断——用户不需要看日志、不需要贴报告。
 *
 * 记录构成由 autocheck-record.ts 的纯函数负责（可单测）：
 *   - 没测到的 state 写 null，不写 'unavailable' 占位串
 *   - 带上曲目 id / source / 直链主机，异常才能归因到具体歌曲与链路
 */
import { writeFile } from '@/utils/fs'
import { externalStorageDirectoryPath } from '@/utils/fs'
import TrackPlayer from 'react-native-track-player'
import { log } from '@/utils/log'
import { reportError } from '@/core/listen-together/errors'
import { buildCheckRecord, type ActiveTrackLike, type CheckRecord } from './autocheck-record'

const OUT_PATH = `${externalStorageDirectoryPath}/lxsp-autocheck.json`

const records: CheckRecord[] = []
let seq = 0
let pending: ReturnType<typeof setTimeout> | null = null

/** 可选的 TrackPlayer 能力（本项目的 RNTP 版本不保证都有，必须按可选调用处理） */
type OptionalTrackPlayer = {
  getActiveTrack?: () => Promise<ActiveTrackLike | undefined>
  getPlaybackState?: () => Promise<{ state?: unknown } | undefined>
}

const flush = async(): Promise<void> => {
  try {
    await writeFile(OUT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), records }, null, 2))
    log.info(`[autocheck] wrote ${records.length} records → ${OUT_PATH}`)
  } catch (error) {
    log.warn(`[autocheck] write failed: ${(error as Error).message}`)
    // 写盘失败必须可观测（Android 分区存储会拒绝 /sdcard 根目录写入）
    reportError('autocheck:write', error)
  }
}

/** 读当前活动轨；API 不存在就是 null（不是错误），调用本身失败才上报 */
const readActiveTrack = async(): Promise<ActiveTrackLike | null> => {
  const getter = (TrackPlayer as unknown as OptionalTrackPlayer).getActiveTrack
  if (typeof getter !== 'function') return null
  try {
    return (await getter()) ?? null
  } catch (error) {
    reportError('autocheck:active-track', error)
    return null
  }
}

/** 读原生播放状态；拿不到就是 null（占位串会把「没测到」伪装成「状态是 unavailable」） */
const readState = async(): Promise<unknown> => {
  const getter = (TrackPlayer as unknown as OptionalTrackPlayer).getPlaybackState
  if (typeof getter !== 'function') return null
  try {
    const info = await getter()
    return info?.state ?? null
  } catch (error) {
    reportError('autocheck:state', error)
    return null
  }
}

/** Ready 事件后调用：3 秒后采样一次并落盘（每首歌一条） */
export const scheduleAutocheck = (label: string): void => {
  pending && clearTimeout(pending)
  pending = setTimeout(() => {
    pending = null
    void (async() => {
      const durationMs = await TrackPlayer.getDuration().then(v => Number(v) || 0).catch(error => {
        reportError('autocheck:duration', error)
        return 0
      })
      const positionMs = await TrackPlayer.getPosition().then(v => Number(v) || 0).catch(error => {
        reportError('autocheck:position', error)
        return 0
      })
      const activeTrack = await readActiveTrack()
      const state = await readState()
      seq += 1
      const record = buildCheckRecord({
        at: new Date().toISOString(),
        seq,
        durationMs,
        positionMs,
        state,
        activeTrack,
      })
      records.push(record)
      records.length > 20 && records.shift()
      log.info(
        `[autocheck] #${record.seq} ${label} duration=${record.durationMs}ms position=${record.positionMs}ms ` +
        `state=${record.state ?? 'null'} track=${record.trackSource ?? '-'}:${record.trackId ?? '-'}@${record.trackUrlHost ?? '-'} ok=${record.ok}`,
      )
      await flush()
    })()
  }, 3000)
}
