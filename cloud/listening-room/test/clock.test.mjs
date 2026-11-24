/** 锚点状态机 + 时钟同步 */
import {
  anchorForPause, anchorForPlay, anchorForSeek, anchorForSetTrack,
  computeSample, mergeSample, playheadAt, emptyClockSync, localPlayhead, LEAD_MS,
} from '../src/clock.ts'
import { emptyPlayback } from '../src/protocol.ts'

const base = () => ({ positionMs: 30_000, anchorServerMs: 1_000_000, isPlaying: true, trackStableKey: 'kw:42' })

export default (t) => {
  t.suite('播放头：在播才走，暂停不动', () => {
    t.eq(playheadAt(base(), 1_000_000), 30_000, '锚点时刻等于 positionMs')
    t.eq(playheadAt(base(), 1_003_000), 33_000, '过了 3 秒走 3 秒')
    t.eq(playheadAt({ ...base(), isPlaying: false }, 1_100_000), 30_000, '暂停后不前进')
    t.eq(playheadAt({ ...base(), anchorServerMs: 1_010_000 }, 1_000_000), 30_000, '锚点在未来（提前量）不倒退')
  })

  t.suite('PLAY：锚点前置 400ms，位置不动', () => {
    const next = anchorForPlay({ ...base(), isPlaying: false }, 2_000_000)
    t.eq(next.anchorServerMs, 2_000_000 + LEAD_MS)
    t.eq(next.positionMs, 30_000)
    t.eq(next.isPlaying, true)
  })

  t.suite('PAUSE：位置定格在“现在”，锚点就是现在', () => {
    const next = anchorForPause(base(), 1_002_500)
    t.eq(next.positionMs, 32_500)
    t.eq(next.anchorServerMs, 1_002_500)
    t.eq(next.isPlaying, false)
  })

  t.suite('SEEK：在播前置 400ms，暂停以现在为锚', () => {
    const playing = anchorForSeek(base(), 2_000_000, 5000)
    t.eq([playing.positionMs, playing.anchorServerMs, playing.isPlaying], [5000, 2_000_400, true])
    const paused = anchorForSeek({ ...base(), isPlaying: false }, 2_000_000, 5000)
    t.eq([paused.positionMs, paused.anchorServerMs], [5000, 2_000_000])
  })

  t.suite('SET_TRACK：位置归零、必定开播、锚点前置 400ms', () => {
    const next = anchorForSetTrack({ ...emptyPlayback(), isPlaying: false }, 3_000_000, 'kg:abc')
    t.eq([next.positionMs, next.anchorServerMs, next.isPlaying, next.trackStableKey], [0, 3_000_400, true, 'kg:abc'])
  })

  t.suite('时钟同步：只保留 RTT 最小的样本', () => {
    const s0 = emptyClockSync()
    const s1 = mergeSample(s0, computeSample(1000, 1200, 500_300))  // rtt 200 → offset ≈ 500300-(1000+100)=499200
    const s2 = mergeSample(s1, computeSample(2000, 2040, 601_300))  // rtt 40 → 更好
    const s3 = mergeSample(s2, computeSample(3000, 3300, 700_100))  // rtt 300 → 丢弃
    t.eq(s1.bestRttMs, 200)
    t.eq(s2.bestRttMs, 40, '更小 RTT 覆盖')
    t.eq(s3.bestRttMs, 40, '更大 RTT 不覆盖')
    t.eq(Math.round(s2.offsetMs), 599_280, 'offset ≈ serverNow - (clientNow + rtt/2)')
    t.eq([s1.samples, s2.samples, s3.samples], [1, 2, 3], '采样计数照常增加')
    const head = localPlayhead(base(), 1_000_000 - Math.round(s2.offsetMs) + 2000, s2)
    t.eq(head, 32_000, '用校准后的服务端时间算播放头')
  })
}
