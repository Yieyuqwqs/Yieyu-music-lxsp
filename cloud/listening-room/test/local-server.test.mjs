/** 本机房服务：真实 HTTP + 真实 WebSocket（node 自带）端到端 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SERVER = fileURLToPath(new URL('../local-server.mjs', import.meta.url))
const PORT = 1199
const BASE = `http://127.0.0.1:${PORT}`

const startServer = async() => {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'pipe' })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务没起来')), 8000)
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('已启动')) { clearTimeout(timer); resolve() }
    })
    child.stderr.on('data', chunk => { /* 忽略启动噪音 */ })
  })
  await ready
  return child
}

const api = async(path, body) => {
  const response = await fetch(BASE + path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return response.json()
}

const open = (wsUrl, onMessage) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl)
  ws.onopen = () => resolve(ws)
  ws.onerror = () => reject(new Error('ws 连接失败'))
  ws.onmessage = event => onMessage(JSON.parse(event.data))
})

const waitFor = async(predicate, timeoutMs = 3000) => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

export default (t) => {
  t.suite('本机房服务：建房 → 两人加入 → WS 连上 → 房主 PLAY 广播锚点', async() => {
    const child = await startServer()
    try {
      const created = await api('/api/rooms', {})
      t.eq(created.ok, true, '建房 ok')
      const roomId = created.data.roomId

      const host = (await api(`/api/rooms/${roomId}/join`, {})).data
      const guest = (await api(`/api/rooms/${roomId}/join`, {})).data
      t.eq(host.role, 'CONTROLLER')
      t.eq(guest.role, 'LISTENER')

      const states = []
      const hostWs = await open(host.wsUrl, msg => { if (msg.type === 'room_state_updated') states.push(msg) })
      const guestWs = await open(guest.wsUrl, msg => { if (msg.type === 'room_state_updated') states.push(msg) })

      await waitFor(() => states.length >= 2)

      const before = Date.now()
      hostWs.send(JSON.stringify({ type: 'SET_QUEUE', queue: [{ stableKey: 'kw:1', id: '1', source: 'kw', name: 'A', singer: 'B', durationMs: 1 }], currentIndex: 0 }))
      await waitFor(() => states.some(s => s.state.queue.length === 1))
      hostWs.send(JSON.stringify({ type: 'PLAY' }))
      await waitFor(() => states.some(s => s.state.playback.isPlaying))

      const playing = states.filter(s => s.state.playback.isPlaying).pop()
      t.ok(playing, '收到播放状态')
      t.ok(playing.state.playback.anchorServerMs >= before + 300, 'PLAY 锚点前置 400ms')
      t.eq(playing.state.playback.trackStableKey, 'kw:1')

      // 成员请求：key 不对被拒，对了被接受
      const guestMessages = []
      guestWs.onmessage = event => guestMessages.push(JSON.parse(event.data))
      guestWs.send(JSON.stringify({ type: 'REQUEST_PAUSE', requestTrackStableKey: 'kw:999' }))
      await waitFor(() => guestMessages.some(m => m.type === 'request_rejected'))
      t.ok(guestMessages.some(m => m.type === 'request_rejected'), '错误 key 被拒')

      hostWs.send(JSON.stringify({ type: 'PAUSE' }))
      await waitFor(() => states.some(s => !s.state.playback.isPlaying))
      guestWs.send(JSON.stringify({ type: 'REQUEST_PLAY', requestTrackStableKey: 'kw:1' }))
      await waitFor(() => guestMessages.some(m => m.type === 'request_acked'))
      t.ok(guestMessages.some(m => m.type === 'request_acked'), '正确 key → acked')

      // 时钟同步
      const pongs = []
      hostWs.onmessage = event => { const m = JSON.parse(event.data); if (m.type === 'np_pong') pongs.push(m) }
      const clientNow = Date.now()
      hostWs.send(JSON.stringify({ type: 'np_ping', clientNow }))
      await waitFor(() => pongs.length > 0)
      t.eq(pongs[0]?.clientNow, clientNow)
      t.ok(pongs[0]?.serverNow > 1_600_000_000_000, 'serverNow 合理')

      hostWs.close()
      guestWs.close()
    } finally {
      child.kill()
    }
  })
}
