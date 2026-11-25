/**
 * 自动核验记录的不变量（纯函数，无 RN 依赖）
 *
 * 根因：旧记录把占位串 'unavailable' 当测量值写盘，且不带曲目信息，
 * 于是「247ms 伪时长」无法归因到任何一层。这三条不变量一旦破，
 * /sdcard/lxsp-autocheck.json 就又变回不能当证据的文件。
 */
import { buildCheckRecord, hostOf, OK_DURATION_MS } from '../../src/core/listen-together/autocheck-record.ts'

const base = {
  at: '2026-11-25T04:03:11.356Z',
  seq: 1,
  durationMs: 247,
  positionMs: 0,
  state: 'playing',
  activeTrack: { id: 'kw_3315311', url: 'http://car-bj.kuwo.cn/x/2083701040.mp3?sign=SECRET', source: 'kw' },
}

export default (t) => {
  t.suite('核验记录：没测到的 state 必须是 null，不许写可用性占位串', () => {
    t.eq(buildCheckRecord({ ...base, state: null }).state, null, 'null 就是 null')
    t.eq(buildCheckRecord({ ...base, state: undefined }).state, null, 'undefined → null')
    t.eq(buildCheckRecord({ ...base, state: 'unavailable' }).state, 'unavailable', '真实上报的字符串原样保留（不替它改语义）')
    t.eq(buildCheckRecord({ ...base, state: 'playing' }).state, 'playing', '有测量值就原样落盘')
  })

  t.suite('核验记录：直链只落主机名，签名参数绝不入库', () => {
    t.eq(hostOf('http://car-bj.kuwo.cn/x/1.mp3?sign=SECRET&t=1'), 'car-bj.kuwo.cn', '只保留 host')
    t.eq(hostOf('https://m702.music.126.net:8443/a.mp3'), 'm702.music.126.net:8443', '端口保留')
    t.eq(hostOf(null), null, 'null → null')
    t.eq(hostOf(''), null, '空串 → null')
    t.eq(hostOf('file:///sdcard/a.mp3'), null, 'file 协议不是网络直链 → null')
    const record = buildCheckRecord(base)
    t.eq(record.trackUrlHost, 'car-bj.kuwo.cn', '记录里只有 host')
    t.eq(JSON.stringify(record).includes('SECRET'), false, '记录序列化后不得出现签名')
  })

  t.suite('核验记录：必须能定位到具体曲目（缺活动轨就是 null，不伪造）', () => {
    const record = buildCheckRecord(base)
    t.eq(record.trackId, 'kw_3315311', '曲目 id')
    t.eq(record.trackSource, 'kw', '音源')
    const noTrack = buildCheckRecord({ ...base, activeTrack: null })
    t.eq([noTrack.trackId, noTrack.trackSource, noTrack.trackUrlHost], [null, null, null], '拿不到活动轨就三个 null')
    const noUrl = buildCheckRecord({ ...base, activeTrack: { id: 'a', source: 'wy' } })
    t.eq(noUrl.trackUrlHost, null, '没有直链时 host 为 null')
  })

  t.suite('核验记录：ok 只由 duration 决定，247ms 永远不 ok', () => {
    t.eq(buildCheckRecord(base).ok, false, '247ms 不算核验通过')
    t.eq(buildCheckRecord({ ...base, durationMs: OK_DURATION_MS }).ok, false, '刚好等于门槛不算通过')
    t.eq(buildCheckRecord({ ...base, durationMs: 247_000 }).ok, true, '247 秒才算真歌')
    t.eq(buildCheckRecord({ ...base, durationMs: Number.NaN }).durationMs, 0, 'NaN 归零而不是写入 NaN')
  })
}
