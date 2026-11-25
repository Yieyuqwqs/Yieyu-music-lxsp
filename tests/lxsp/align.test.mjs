/**
 * 一起听 · 起播对齐的不变量（纯逻辑，不涉及网络/播放器）
 *
 * 根因（2026-11-25 接管审计）：room.ts 的注释写着「位置对齐只发生在换歌起播那一刻」，
 * 但实现它的 startTrackAt / scheduleMemberStart 在 #5 收敛时被删掉了，此后没有任何一次 seek →
 * 成员中途进房时永远从 0:00 开始播，房间却在 1:30。
 *
 * 这里把修好后的规则钉成测试：远端换歌 → 本机切歌成功 → 恰好 seek 一次到房间播放头。
 */
import { RoomSession } from '../../src/core/listen-together/room.ts'

const ROOM = {
  roomId: 'r1',
  playback: { positionMs: 90_000, anchorServerMs: 1_000_000, isPlaying: true, trackStableKey: 'kw:1' },
  queue: [{ stableKey: 'kw:1', id: '1', source: 'kw', name: 'A', singer: 'B', durationMs: 1000 }],
  currentIndex: 0,
  playbackMode: 'sequential',
  members: [{ memberId: 'm1', role: 'LISTENER', online: true, joinedAt: 1, lastSeenAt: 1 }],
  settings: { allowListenerRequests: true, requireHostOnline: true, maxMembers: 8 },
  version: 2,
  updatedAt: 1,
}

const makePlayer = (playing = false) => {
  const calls = []
  return {
    calls,
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    seek: (ms) => calls.push(['seek', ms]),
    isPlaying: () => playing,
    positionMs: () => 0,
    currentTrack: () => null,
  }
}

const makeClient = (controller, playheadMs = 90_000) => ({
  isController: controller,
  playheadMs: () => playheadMs,
  on: () => () => {},
  play: () => {},
  pause: () => {},
  seek: () => {},
  setTrack: () => {},
  setMode: () => {},
  notifyTrackFinished: () => {},
  requestPlay: () => {},
  requestPause: () => {},
  requestSeek: () => {},
})

const seeks = calls => calls.filter(call => Array.isArray(call) && call[0] === 'seek')

export default (t) => {
  t.suite('起播对齐：远端换歌后恰好 seek 一次到房间播放头', () => {
    const player = makePlayer()
    const session = new RoomSession({ client: makeClient(false), player })
    session.applyState(ROOM)
    t.eq(seeks(player.calls), [], 'applyState 本身不 seek（此时本机活动轨还是上一首）')
    t.eq(session.alignAfterSwitch(), 90_000, '切歌成功后才对齐，位置=房间播放头')
    t.eq(seeks(player.calls), [['seek', 90_000]], '恰好一次 seek')
    t.eq(session.alignAfterSwitch(), null, '同一首歌不会二次对齐')
    t.eq(seeks(player.calls).length, 1, '仍然只有一次 seek')
  })

  t.suite('起播对齐：同版本重复广播不会制造新的对齐', () => {
    const player = makePlayer()
    const session = new RoomSession({ client: makeClient(false), player })
    session.applyState(ROOM)
    session.applyState(ROOM)
    session.applyState(ROOM)
    session.alignAfterSwitch()
    session.applyState(ROOM)
    t.eq(seeks(player.calls).length, 1, '重复广播只允许一次对齐')
    t.eq(session.alignAfterSwitch(), null, '没有待对齐位置')
  })

  t.suite('起播对齐：同一首歌只是版本变化时不产生对齐（不把用户拽回去）', () => {
    const player = makePlayer()
    const session = new RoomSession({ client: makeClient(false), player })
    session.applyState({ ...ROOM, version: 3 })
    session.alignAfterSwitch()
    const before = seeks(player.calls).length
    session.applyState({ ...ROOM, version: 4 })
    t.eq(session.alignAfterSwitch(), null, '曲目没变就不对齐')
    t.eq(seeks(player.calls).length, before, '没有新的 seek')
  })

  t.suite('起播对齐：控制端不做任何对齐', () => {
    const player = makePlayer()
    const session = new RoomSession({ client: makeClient(true), player })
    session.applyState(ROOM)
    t.eq(session.alignAfterSwitch(), null, '控制端以本地为准')
    t.eq(seeks(player.calls), [], '控制端不 seek')
  })

  t.suite('版本守卫：stop() 之后同一个版本号必须能重新应用（新房间会复用版本号）', () => {
    const player = makePlayer(true)
    const session = new RoomSession({ client: makeClient(false), player })
    const paused = { ...ROOM, version: 9, playback: { ...ROOM.playback, isPlaying: false } }
    session.applyState(paused)
    t.eq(player.calls.includes('pause'), true, '第一个房间的暂停已应用')
    session.stop()
    const before = player.calls.length
    session.applyState(paused)
    t.eq(player.calls.length > before, true, '换房后同版本号不能被当成“已应用过”而丢弃')
    t.eq(session.alignAfterSwitch(), 90_000, '重连后的第一次换歌仍然要起播对齐')
  })
}
