/** DO 消息流：权限、REQUEST_* 校验、锚点广播、断线重连、队列推进 */
import { installStubs, createHarness } from './harness.mjs'

installStubs()
const { ListeningRoomDO } = await import('../src/room-do.ts')
const { trackStableKey } = await import('../src/protocol.ts')

const track = (id) => ({
  stableKey: trackStableKey('kw', id), id, source: 'kw', name: `歌${id}`, singer: '人', durationMs: 200_000,
})

const openRoom = async () => {
  const h = createHarness()
  const room = new ListeningRoomDO(h.ctx, {})
  await room.fetch(new Request('https://room/init?roomId=room1234', { method: 'POST' }))

  const join = async (role) => {
    const response = await room.fetch(new Request('https://room/join', {
      method: 'POST',
      body: JSON.stringify(role ? { role } : {}),
    }))
    return (await response.json()).data
  }

  const connect = async (joined) => {
    const response = await room.fetch(new Request(
      `https://room/ws?memberId=${joined.memberId}&memberSecret=${encodeURIComponent(joined.memberSecret)}`,
      { headers: { Upgrade: 'websocket' } },
    ))
    const ws = h.sockets[h.sockets.length - 1].ws
    return { ws, status: response.status, sent: ws.sent }
  }

  return { h, room, join, connect }
}

const lastState = (ws) => {
  for (let i = ws.sent.length - 1; i >= 0; i--) {
    const message = JSON.parse(ws.sent[i])
    if (message.type === 'room_state_updated') return message
  }
  return null
}

export default (t) => {
  t.suite('建房 + 加入：第一个是 CONTROLLER，第二个是 LISTENER', async() => {
    const { join } = await openRoom()
    const a = await join()
    const b = await join()
    t.eq(a.role, 'CONTROLLER')
    t.eq(b.role, 'LISTENER')
    t.ok(a.wsUrl.includes('/ws?memberId='), 'wsUrl 带 memberId')
    t.ok(a.memberSecret.length > 10, '给了 memberSecret 用于重连')
  })

  t.suite('握手校验：secret 不对 → 401', async() => {
    const { room, join } = await openRoom()
    const a = await join()
    const response = await room.fetch(new Request(`https://room/ws?memberId=${a.memberId}&memberSecret=wrong`, { headers: { Upgrade: 'websocket' } }))
    t.eq(response.status, 401)
  })

  t.suite('控制端：SET_QUEUE → PLAY，锚点是 now+400，状态广播给所有人', async() => {
    const { h, room, join, connect } = await openRoom()
    const a = await join()
    const b = await join()
    const connA = await connect(a)
    const connB = await connect(b)

    const before = Date.now()
    await room.webSocketMessage(connA.ws, JSON.stringify({ type: 'SET_QUEUE', queue: [track('1'), track('2')], currentIndex: 0 }))
    await room.webSocketMessage(connA.ws, JSON.stringify({ type: 'PAUSE' }))
    await room.webSocketMessage(connA.ws, JSON.stringify({ type: 'PLAY' }))

    const state = lastState(connB.ws)
    t.ok(state, 'LISTENER 也收到广播')
    t.eq(state.state.playback.isPlaying, true)
    t.ok(state.state.playback.anchorServerMs >= before + 400, 'PLAY 锚点前置 400ms')
    t.eq(state.state.queue.length, 2)
    t.eq(state.state.currentIndex, 0)
  })

  t.suite('权限：LISTENER 直接发 PLAY → forbidden', async() => {
    const { room, join, connect } = await openRoom()
    const a = await join()
    const b = await join()
    await connect(a)
    const connB = await connect(b)
    await room.webSocketMessage(connB.ws, JSON.stringify({ type: 'PLAY' }))
    const errors = connB.ws.sent.map(item => JSON.parse(item)).filter(item => item.type === 'error')
    t.eq(errors[0]?.code, 'forbidden')
  })

  t.suite('REQUEST_*：key 不对被拒，key 对了转控制并 ack', async() => {
    const { room, join, connect } = await openRoom()
    const a = await join()
    const b = await join()
    const connA = await connect(a)
    const connB = await connect(b)
    await room.webSocketMessage(connA.ws, JSON.stringify({ type: 'SET_QUEUE', queue: [track('1')], currentIndex: 0 }))
    await room.webSocketMessage(connA.ws, JSON.stringify({ type: 'PAUSE' }))

    await room.webSocketMessage(connB.ws, JSON.stringify({ type: 'REQUEST_PLAY', requestTrackStableKey: 'kw:999' }))
    const rejected = connB.ws.sent.map(item => JSON.parse(item)).find(item => item.type === 'request_rejected')
    t.ok(rejected, '校验失败被拒')
    t.ok(String(rejected.reason).includes('requestTrackStableKey'), '原因说清楚')

    await room.webSocketMessage(connB.ws, JSON.stringify({ type: 'REQUEST_PLAY', requestTrackStableKey: 'kw:1' }))
    const acked = connB.ws.sent.map(item => JSON.parse(item)).find(item => item.type === 'request_acked')
    t.eq(acked.requestType, 'REQUEST_PLAY')
    t.eq(lastState(connB.ws).state.playback.isPlaying, true, '转成了真正的 PLAY')
  })

  t.suite('房主离线时：默认拒绝成员请求（requireHostOnline）', async() => {
    const { h, room, join, connect } = await openRoom()
    const a = await join()
    const b = await join()
    const connA = await connect(a)
    const connB = await connect(b)
    await room.webSocketMessage(connA.ws, JSON.stringify({ type: 'SET_QUEUE', queue: [track('1')], currentIndex: 0 }))
    await room.webSocketClose(connA.ws) // 房主掉线
    await room.webSocketMessage(connB.ws, JSON.stringify({ type: 'REQUEST_PAUSE', requestTrackStableKey: 'kw:1' }))
    const rejected = connB.ws.sent.map(item => JSON.parse(item)).filter(item => item.type === 'request_rejected').pop()
    t.ok(String(rejected?.reason ?? '').includes('房主'), '给出了「房主不在线」的原因')
  })

  t.suite('断线重连：角色不变、不会因为重连而暂停', async() => {
    const { room, join, connect } = await openRoom()
    const a = await join()
    const connA = await connect(a)
    await room.webSocketMessage(connA.ws, JSON.stringify({ type: 'SET_QUEUE', queue: [track('1')], currentIndex: 0 }))
    await room.webSocketMessage(connA.ws, JSON.stringify({ type: 'PLAY' }))
    await room.webSocketClose(connA.ws)

    const again = await connect(a) // 用同一个 memberId/memberSecret 重连
    t.eq(again.status, 101, '重连成功')
    const state = lastState(again.ws).state
    t.eq(state.playback.isPlaying, true, '重连不触发暂停')
    t.eq(state.members.find(m => m.memberId === a.memberId).role, 'CONTROLLER', '角色保持')
  })

  t.suite('TRACK_FINISHED：单曲循环原地、列表循环回绕、顺序播放到尾就停', async() => {
    const { room, join, connect } = await openRoom()
    const a = await join()
    const conn = await connect(a)
    await room.webSocketMessage(conn.ws, JSON.stringify({ type: 'SET_QUEUE', queue: [track('1'), track('2')], currentIndex: 0 }))

    await room.webSocketMessage(conn.ws, JSON.stringify({ type: 'PLAYBACK_MODE', mode: 'singleLoop' }))
    await room.webSocketMessage(conn.ws, JSON.stringify({ type: 'TRACK_FINISHED', trackStableKey: 'kw:1' }))
    t.eq(lastState(conn.ws).state.currentIndex, 0, '单曲循环还是第 0 首')

    await room.webSocketMessage(conn.ws, JSON.stringify({ type: 'PLAYBACK_MODE', mode: 'listLoop' }))
    await room.webSocketMessage(conn.ws, JSON.stringify({ type: 'TRACK_FINISHED', trackStableKey: 'kw:1' }))
    t.eq(lastState(conn.ws).state.currentIndex, 1, '列表循环下一首')

    await room.webSocketMessage(conn.ws, JSON.stringify({ type: 'PLAYBACK_MODE', mode: 'sequential' }))
    await room.webSocketMessage(conn.ws, JSON.stringify({ type: 'TRACK_FINISHED', trackStableKey: 'kw:2' }))
    const end = lastState(conn.ws).state
    t.eq(end.playback.isPlaying, false, '顺序播放到尾停下')
  })

  t.suite('时钟：np_ping → np_pong 带回 clientNow 与 serverNow', async() => {
    const { room, join, connect } = await openRoom()
    const a = await join()
    const conn = await connect(a)
    await room.webSocketMessage(conn.ws, JSON.stringify({ type: 'np_ping', clientNow: 12345, clientId: 'c1' }))
    const pong = conn.ws.sent.map(item => JSON.parse(item)).find(item => item.type === 'np_pong')
    t.eq(pong.clientNow, 12345)
    t.ok(pong.serverNow > 1_600_000_000_000, 'serverNow 是服务器时间')
  })

  t.suite('直链候选：最多三条、换曲即清空、不落盘', async() => {
    const { h, room, join, connect } = await openRoom()
    const a = await join()
    const conn = await connect(a)
    room.rememberCandidate(a.memberId, 'u1')
    room.rememberCandidate(a.memberId, 'u2')
    room.rememberCandidate(a.memberId, 'u3')
    room.rememberCandidate(a.memberId, 'u4')
    t.eq(room.candidatesOf(a.memberId), ['u4', 'u3', 'u2'], '只留最近三条')
    await room.webSocketMessage(conn.ws, JSON.stringify({ type: 'SET_QUEUE', queue: [track('1')], currentIndex: 0 }))
    t.eq(room.candidatesOf(a.memberId), [], '换曲清空')
    const persisted = JSON.stringify([...h.store.entries()])
    t.eq(persisted.includes('http'), false, '持久化里没有直链')
  })

  t.suite('10 秒广播：alarm 到点会推完整快照并续约', async() => {
    const { h, room, join, connect } = await openRoom()
    const a = await join()
    const conn = await connect(a)
    conn.ws.sent.length = 0
    await room.alarm()
    const message = conn.ws.sent.map(item => JSON.parse(item)).find(item => item.type === 'room_state_updated')
    t.ok(message, 'alarm 主动广播')
    t.ok(h.alarms.length >= 1, '重新排了下一个 alarm')
  })
}
