// human-exempt: 纯逻辑测试（RoomSession 的权限/版本守卫），不涉及网络、ExoPlayer、跨进程
// 之所以用替身：RoomSession 的职责就是"把事件翻译成播放器调用"，用真实播放器无法断言"系统有没有调用 seek"
import { RoomSession } from '../../src/core/listen-together/room.ts'

const ROOM = {
  roomId: 'r1',
  playback: { positionMs: 30_000, anchorServerMs: 1_000_000, isPlaying: true, trackStableKey: 'kw:1' },
  queue: [{ stableKey: 'kw:1', id: '1', source: 'kw', name: 'A', singer: 'B', durationMs: 1000 }],
  currentIndex: 0,
  playbackMode: 'sequential',
  members: [{ memberId: 'm1', role: 'LISTENER', online: true, joinedAt: 1, lastSeenAt: 1 }],
  settings: { allowListenerRequests: true, requireHostOnline: true, maxMembers: 8 },
  version: 1,
  updatedAt: 1,
}

const makePlayer = () => {
  const calls = []
  return {
    calls,
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    seek: (ms) => calls.push(['seek', ms]),
    isPlaying: () => false,
    positionMs: () => 0,
    currentTrack: () => null,
    setRate: (r) => calls.push(['rate', r]),
  }
}

const makeClient = (controller) => {
  const sent = []
  return {
    sent,
    isController: controller,
    playheadMs: () => 30_000,
    on: () => () => {},
    play: () => sent.push('PLAY'),
    pause: () => sent.push('PAUSE'),
    seek: (ms) => sent.push(['SEEK', ms]),
    setTrack: () => sent.push('SET_TRACK'),
    setMode: () => sent.push('SET_MODE'),
    notifyTrackFinished: () => sent.push('FINISHED'),
    requestPlay: () => sent.push('REQ_PLAY'),
    requestPause: () => sent.push('REQ_PAUSE'),
    requestSeek: () => sent.push('REQ_SEEK'),
  }
}

export default (t) => {
  t.suite('RoomSession：控制端以本地为准，不应用远端状态', () => {
    const player = makePlayer()
    const client = makeClient(true)
    const session = new RoomSession({ client, player })
    t.eq(session.applyState(ROOM), [], '控制端不产生任何事件')
    t.eq(player.calls, [], '控制端不操作播放器')
  })

  t.suite('RoomSession：同版本状态重复到达时不再重复应用（防跳回）', () => {
    const player = makePlayer()
    const client = makeClient(false)
    const session = new RoomSession({ client, player })
    session.applyState({ ...ROOM, version: 5 })
    const first = player.calls.length
    session.applyState({ ...ROOM, version: 5 })
    session.applyState({ ...ROOM, version: 5 })
    t.eq(player.calls.length, first, '同版本不再触发任何播放器调用')
  })

  t.suite('RoomSession：成员端不得发出控制事件（权限守卫）', () => {
    const player = makePlayer()
    const client = makeClient(false)
    const session = new RoomSession({ client, player })
    session.notifyPlay()
    session.notifyPause()
    session.notifySeek(1000)
    session.notifyTrackChanged()
    t.eq(client.sent, [], '成员端一条控制事件都不许发')
  })

  t.suite('RoomSession：控制端发送控制事件', () => {
    const player = makePlayer()
    const client = makeClient(true)
    const session = new RoomSession({ client, player })
    session.notifyPlay()
    session.notifyPause()
    t.eq(client.sent, ['PLAY', 'PAUSE'])
  })
}
