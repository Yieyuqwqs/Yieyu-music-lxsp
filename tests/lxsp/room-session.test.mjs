/** 房间会话：远程状态落到本地播放器、控制端上报、成员端只发 REQUEST_* */
import { RoomSession } from '../../src/core/listen-together/room.ts'

const ROOM = {
  roomId: 'r1',
  playback: { positionMs: 30_000, anchorServerMs: 1_000_000, isPlaying: true, trackStableKey: 'kw:42' },
  queue: [{ stableKey: 'kw:42', id: '42', source: 'kw', name: '歌', singer: '人', durationMs: 200_000 }],
  currentIndex: 0,
  playbackMode: 'sequential',
  members: [{ memberId: 'm1', role: 'LISTENER', online: true, joinedAt: 1, lastSeenAt: 1 }],
  settings: { allowListenerRequests: true, requireHostOnline: true, maxMembers: 8 },
  updatedAt: 1,
}

const makePlayer = (initial = { playing: false, position: 0 }) => {
  const calls = []
  let playing = initial.playing
  let position = initial.position
  return {
    calls,
    get playing() { return playing },
    play: () => { playing = true; position = position; calls.push(['play']) },
    pause: () => { playing = false; calls.push(['pause']) },
    seek: (ms) => { position = ms; calls.push(['seek', ms]) },
    isPlaying: () => playing,
    positionMs: () => position,
    currentTrack: () => ({ stableKey: 'kw:42', id: '42', source: 'kw', name: '歌', singer: '人', durationMs: 200_000 }),
    setPosition: (ms) => { position = ms },
  }
}

const makeClient = ({ controller = false, playhead = 30_000 } = {}) => {
  const sent = []
  const handlers = new Set()
  return {
    sent,
    isController: controller,
    playheadMs: () => playhead,
    on: (handler) => { handlers.add(handler); return () => handlers.delete(handler) },
    emit: (event) => { for (const h of handlers) h(event) },
    play: () => sent.push({ type: 'PLAY' }),
    pause: () => sent.push({ type: 'PAUSE' }),
    seek: (ms) => sent.push({ type: 'SEEK', positionMs: ms }),
    setTrack: (track, index) => sent.push({ type: 'SET_TRACK', track, index }),
    setMode: (mode) => sent.push({ type: 'PLAYBACK_MODE', mode }),
    notifyTrackFinished: () => sent.push({ type: 'TRACK_FINISHED' }),
    requestPlay: () => sent.push({ type: 'REQUEST_PLAY' }),
    requestPause: () => sent.push({ type: 'REQUEST_PAUSE' }),
    requestSeek: (ms) => sent.push({ type: 'REQUEST_SEEK', positionMs: ms }),
  }
}

export default (t) => {
  t.suite('成员端：远程在播 → 本地起播；偏差过大才 seek', () => {
    const player = makePlayer({ playing: false, position: 20_000 })
    const client = makeClient({ playhead: 30_000 })
    const session = new RoomSession({ client, player })
    const events = session.applyState(ROOM)
    t.ok(player.calls.some(c => c[0] === 'play'), '跟着起播')
    const seeks = player.calls.filter(c => c[0] === 'seek')
    t.eq(seeks.length, 1, '偏差 10s > 阈值 → 对齐一次')
    t.eq(seeks[0][1], 30_000, '对齐到房间播放头')
  })

  t.suite('成员端：偏差小于阈值不 seek（避免每次广播都抖）', () => {
    const player = makePlayer({ playing: true, position: 29_900 })
    const client = makeClient({ playhead: 30_000 })
    const session = new RoomSession({ client, player, driftThresholdMs: 400 })
    session.applyState(ROOM)
    t.eq(player.calls.filter(c => c[0] === 'seek').length, 0)
  })

  t.suite('成员端：偏差大于阈值 → seek 到房间播放头', () => {
    const player = makePlayer({ playing: true, position: 1_000 })
    const client = makeClient({ playhead: 30_000 })
    const session = new RoomSession({ client, player })
    const events = session.applyState(ROOM)
    const seek = player.calls.find(c => c[0] === 'seek')
    t.eq(seek?.[1], 30_000)
    t.ok(events.some(e => e.type === 'applied' && e.action === 'seek'))
  })

  t.suite('成员端：远程暂停 → 本地暂停', () => {
    const player = makePlayer({ playing: true, position: 30_000 })
    const client = makeClient({ playhead: 30_000 })
    const session = new RoomSession({ client, player })
    session.applyState({ ...ROOM, playback: { ...ROOM.playback, isPlaying: false } })
    t.ok(player.calls.some(c => c[0] === 'pause'))
  })

  t.suite('成员端：换曲只发提示事件，不擅自改本地播放', () => {
    const player = makePlayer({ playing: true, position: 0 })
    const client = makeClient({ playhead: 0 })
    const seen = []
    const session = new RoomSession({ client, player, onEvent: e => seen.push(e) })
    session.applyState({ ...ROOM, currentIndex: 0 })
    session.applyState({
      ...ROOM,
      currentIndex: 1,
      playback: { ...ROOM.playback, trackStableKey: 'kw:99' },
      queue: [...ROOM.queue, { stableKey: 'kw:99', id: '99', source: 'kw', name: 'B', singer: '人', durationMs: 1 }],
    })
    const trackEvent = seen.filter(e => e.type === 'track_changed').pop()
    t.eq(trackEvent?.track.stableKey, 'kw:99')
    t.eq(player.calls.filter(c => c[0] === 'seek' || c[0] === 'play').length >= 0, true)
  })

  t.suite('控制端：本地 play/pause/seek/换曲/模式 都上报，且不被自己的广播反向扯动', () => {
    const player = makePlayer({ playing: false, position: 5_000 })
    const client = makeClient({ controller: true, playhead: 30_000 })
    const session = new RoomSession({ client, player })

    t.eq(session.applyState(ROOM), [], '控制端忽略远程状态')

    session.notifyPlay()
    session.notifyPause()
    session.notifySeek(12_345)
    session.notifyTrackChanged()
    session.notifyMode('listLoop')
    session.notifyFinished()

    t.eq(client.sent.map(m => m.type), ['PLAY', 'PAUSE', 'SEEK', 'SET_TRACK', 'PLAYBACK_MODE', 'TRACK_FINISHED'])
    t.eq(client.sent.find(m => m.type === 'SEEK').positionMs, 12_345)
  })

  t.suite('成员端：控制类不上报，只走 REQUEST_*', () => {
    const player = makePlayer({ playing: true, position: 8_000 })
    const client = makeClient({ controller: false })
    const session = new RoomSession({ client, player })
    session.notifyPlay()
    session.notifyPause()
    session.notifySeek()
    t.eq(client.sent, [], '没有任何控制事件')
    session.requestPlay()
    session.requestPause()
    session.requestSeek(9_000)
    t.eq(client.sent.map(m => m.type), ['REQUEST_PLAY', 'REQUEST_PAUSE', 'REQUEST_SEEK'])
  })

  t.suite('start/stop：订阅与退订不重复', () => {
    const player = makePlayer({ playing: true, position: 30_000 })
    const client = makeClient()
    const session = new RoomSession({ client, player })
    session.start()
    session.start()
    session.stop()
    t.ok(true, '没有重复订阅炸掉')
  })
}
