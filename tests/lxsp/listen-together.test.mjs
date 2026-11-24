/** 一起听客户端：建房/加入、状态镜像、时钟校准、请求事件、断线重连 */
import { ListenTogetherClient } from '../../src/core/listen-together/client.ts'
import { localPlayhead, mergePong, emptyClockSync } from '../../src/core/listen-together/playhead.ts'

const ROOM = {
  roomId: 'r1',
  playback: { positionMs: 10_000, anchorServerMs: 1_000_000, isPlaying: true, trackStableKey: 'kw:42' },
  queue: [{ stableKey: 'kw:42', id: '42', source: 'kw', name: '歌', singer: '人', durationMs: 200_000 }],
  currentIndex: 0,
  playbackMode: 'sequential',
  members: [{ memberId: 'm1', role: 'LISTENER', online: true, joinedAt: 1, lastSeenAt: 1 }],
  settings: { allowListenerRequests: true, requireHostOnline: true, maxMembers: 8 },
  updatedAt: 1,
}

const fakeFetch = (routes) => {
  const calls = []
  const impl = async(url, init) => {
    const path = new URL(url).pathname
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body })
    const handler = routes[path]
    if (!handler) return { status: 404, json: async() => ({ ok: false, error: { code: 'not_found', message: 'no route' } }) }
    return { status: 200, json: async() => ({ ok: true, data: handler(init) }) }
  }
  return { impl, calls }
}

const fakeWs = () => {
  const sent = []
  const ws = {
    sent,
    readyState: 1,
    send: (data) => sent.push(JSON.parse(data)),
    close: () => { ws.onclose?.({ code: 1000 }) },
    onopen: null, onclose: null, onmessage: null, onerror: null,
    push: (message) => ws.onmessage?.({ data: JSON.stringify(message) }),
    open: () => ws.onopen?.(),
  }
  return ws
}

export default (t) => {
  t.suite('播放头：isPlaying 才走，锚点在未来不倒退', () => {
    const sync = emptyClockSync()
    t.eq(localPlayhead(ROOM.playback, 1_000_000, sync), 10_000)
    t.eq(localPlayhead(ROOM.playback, 1_004_000, sync), 14_000)
    t.eq(localPlayhead({ ...ROOM.playback, isPlaying: false }, 1_100_000, sync), 10_000)
    t.eq(localPlayhead({ ...ROOM.playback, anchorServerMs: 2_000_000 }, 1_000_000, sync), 10_000)
  })

  t.suite('时钟校准：只留 RTT 最小的样本', () => {
    const s1 = mergePong(emptyClockSync(), 1000, 1200, 500_300)
    const s2 = mergePong(s1, 2000, 2040, 601_300)
    const s3 = mergePong(s2, 3000, 3300, 700_100)
    t.eq([s1.bestRttMs, s2.bestRttMs, s3.bestRttMs], [200, 40, 40], 'RTT 更大不覆盖')
    t.eq(Math.round(s2.offsetMs), 599_280)
  })

  t.suite('HTTP：建房 → 加入 → 快照 → 离开 都打到对的路径', async() => {
    const { impl, calls } = fakeFetch({
      '/api/rooms': () => ({ roomId: 'r1' }),
      '/api/rooms/r1/join': () => ({ roomId: 'r1', memberId: 'm1', role: 'CONTROLLER', memberSecret: 'sec', wsUrl: 'ws://x/ws?memberId=m1' }),
      '/api/rooms/r1/state': () => ({ state: ROOM, serverNow: 1000 }),
      '/api/rooms/r1/leave': () => ({ roomId: 'r1' }),
    })
    const client = new ListenTogetherClient({ baseUrl: 'https://rt.example.com/', fetchImpl: impl })
    t.eq(await client.createRoom(), 'r1')
    const joined = await client.joinRoom('r1')
    t.eq(joined.role, 'CONTROLLER')
    t.eq((await client.fetchState('r1')).state.roomId, 'r1')
    await client.leave('r1')
    t.eq(calls.map(c => c.path), ['/api/rooms', '/api/rooms/r1/join', '/api/rooms/r1/state', '/api/rooms/r1/leave'])
    t.eq(calls[0].method, 'POST', '建房用 POST')
  })

  t.suite('状态镜像 + 播放头：收到广播后能算出当前位置', () => {
    const ws = fakeWs()
    let now = 1_000_000
    const client = new ListenTogetherClient({
      baseUrl: 'https://rt', fetchImpl: async() => ({ status: 200, json: async() => ({ ok: true, data: {} }) }),
      wsFactory: () => ws, now: () => now, pingIntervalMs: 60_000,
    })
    client.connect({ roomId: 'r1', memberId: 'm1', role: 'LISTENER', memberSecret: 's', wsUrl: 'ws://x' })
    ws.open()
    ws.push({ type: 'room_state_updated', state: ROOM, serverNow: 1_000_000 })
    t.eq(client.roomState.queue.length, 1, '状态被镜像')
    now = 1_010_000
    t.eq(client.playheadMs(), 20_000, '锚点 + 10 秒')
    t.eq(client.isController, false)
    client.disconnect()
  })

  t.suite('时钟：pingOnce 发出 np_ping，pong 回来后 offset 生效', () => {
    const ws = fakeWs()
    let now = 5_000
    const client = new ListenTogetherClient({
      baseUrl: 'https://rt', fetchImpl: async() => ({ status: 200, json: async() => ({ ok: true, data: {} }) }),
      wsFactory: () => ws, now: () => now, pingIntervalMs: 60_000,
    })
    client.connect({ roomId: 'r1', memberId: 'm1', role: 'LISTENER', memberSecret: 's', wsUrl: 'ws://x' })
    ws.open()
    now = 5_000
    client.pingOnce()
    t.eq(ws.sent.find(m => m.type === 'np_ping').clientNow, 5000)
    now = 5_040
    ws.push({ type: 'np_pong', clientNow: 5000, serverNow: 1_000_020 })
    t.eq(client.clock.bestRttMs, 40)
    // offset 假设 RTT 对称：算出来的是「中点时刻」的服务端时间，所以会比 pong 的 serverNow 晚 rtt/2
    t.eq(Math.round(client.serverNowMs()), 1_000_040, 'deviceNow + offset = serverNow + rtt/2')
    client.disconnect()
  })

  t.suite('成员请求：自动补 requestTrackStableKey；被拒时把原因抛给 UI', () => {
    const ws = fakeWs()
    const seen = []
    const client = new ListenTogetherClient({
      baseUrl: 'https://rt', fetchImpl: async() => ({ status: 200, json: async() => ({ ok: true, data: {} }) }),
      wsFactory: () => ws, now: () => 1_000_000, pingIntervalMs: 60_000,
    })
    client.on(event => seen.push(event))
    client.connect({ roomId: 'r1', memberId: 'm1', role: 'LISTENER', memberSecret: 's', wsUrl: 'ws://x' })
    ws.open()
    ws.push({ type: 'room_state_updated', state: ROOM, serverNow: 1_000_000 })

    client.requestPlay()
    t.eq(ws.sent.filter(m => m.type === 'REQUEST_PLAY')[0], { type: 'REQUEST_PLAY', requestTrackStableKey: 'kw:42' })

    ws.push({ type: 'request_rejected', requestType: 'REQUEST_PLAY', memberId: 'm1', reason: '房主不在线' })
    t.eq(seen.filter(e => e.type === 'rejected')[0].reason, '房主不在线')

    ws.push({ type: 'request_acked', requestType: 'REQUEST_PLAY', memberId: 'm1' })
    t.eq(seen.filter(e => e.type === 'acked')[0].requestType, 'REQUEST_PLAY')
    client.disconnect()
  })

  t.suite('断线重连：自动用同一 memberSecret 重连，且不会自己发 PAUSE', async() => {
    const sockets = []
    let now = 1_000_000
    const client = new ListenTogetherClient({
      baseUrl: 'https://rt', fetchImpl: async() => ({ status: 200, json: async() => ({ ok: true, data: {} }) }),
      wsFactory: () => { const ws = fakeWs(); sockets.push(ws); return ws }, now: () => now, pingIntervalMs: 60_000, maxBackoffMs: 10,
    })
    client.connect({ roomId: 'r1', memberId: 'm1', role: 'CONTROLLER', memberSecret: 's', wsUrl: 'ws://x?memberId=m1' })
    sockets[0].open()
    sockets[0].onclose({ code: 1006 }) // 掉线
    await new Promise(resolve => setTimeout(resolve, 60))
    t.eq(sockets.length, 2, '自动重连了一次')
    t.eq(sockets[1].sent.filter(m => m.type === 'PAUSE').length, 0, '重连不触发暂停')
    client.disconnect()
  })

  t.suite('控制端发送：SEEK 取整、TRACK_FINISHED 带当前 key', () => {
    const ws = fakeWs()
    const client = new ListenTogetherClient({
      baseUrl: 'https://rt', fetchImpl: async() => ({ status: 200, json: async() => ({ ok: true, data: {} }) }),
      wsFactory: () => ws, now: () => 1_000_000, pingIntervalMs: 60_000,
    })
    client.connect({ roomId: 'r1', memberId: 'm1', role: 'CONTROLLER', memberSecret: 's', wsUrl: 'ws://x' })
    ws.open()
    ws.push({ type: 'room_state_updated', state: ROOM, serverNow: 1_000_000 })
    client.seek(1234.9)
    client.notifyTrackFinished()
    t.eq(ws.sent.find(m => m.type === 'SEEK').positionMs, 1234)
    t.eq(ws.sent.find(m => m.type === 'TRACK_FINISHED').trackStableKey, 'kw:42')
    client.disconnect()
  })
}
