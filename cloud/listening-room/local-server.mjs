#!/usr/bin/env node
/**
 * 一起听 · 本机版房间服务（不依赖 Cloudflare）
 *
 * 用途：workers.dev 在部分网络直接打不通时，用本机进程顶上。
 *   node local-server.mjs            # 监听 127.0.0.1:1103
 *   PORT=1103 HOST=0.0.0.0 node local-server.mjs   # 局域网里别的手机也能连
 *
 * 协议与 Cloudflare 版完全一致（同锚点规则、同消息、同 HTTP 路由），
 * 区别只是：状态在内存里、WebSocket 手写（不需要 ws 依赖）。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { playheadAt, anchorForPlay, anchorForPause, anchorForSeek, anchorForSetTrack } from './dist/clock.js'
import { emptyPlayback, defaultSettings, trackStableKey } from './dist/protocol.js'

const PORT = Number(process.env.PORT || 1103)
const HOST = process.env.HOST || '127.0.0.1'
const LEAD_MS = 400
const BROADCAST_MS = 10_000

const rooms = new Map()

const now = () => Date.now()

const json = (res, body, status = 200) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
  res.end(text)
}
const ok = (res, data) => json(res, { ok: true, data })
const err = (res, code, message, status = 400) => json(res, { ok: false, error: { code, message } }, status)

const createRoom = (roomId) => {
  const room = {
    state: {
      roomId, playback: emptyPlayback(), queue: [], currentIndex: -1,
      playbackMode: 'sequential', members: [], settings: defaultSettings(), updatedAt: now(),
    },
    secrets: new Map(),
    sockets: new Map(), // memberId -> ws
  }
  rooms.set(roomId, room)
  return room
}

const broadcast = (room, message) => {
  const text = JSON.stringify(message)
  for (const ws of room.sockets.values()) sendFrame(ws, text)
}
const broadcastState = (room) => broadcast(room, { type: 'room_state_updated', state: room.state, serverNow: now() })

// ---------------------------------------------------------------- WebSocket 手写实现

const encodeFrame = (text, opcode = 0x1) => {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x80 | opcode, len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  return Buffer.concat([header, payload])
}

const sendFrame = (ws, text) => {
  if (ws.destroyed || !ws.writable) return
  try { ws.write(encodeFrame(text)) } catch (error) { /* 对端断了 */ }
}

const closeFrame = (ws, code = 1000) => {
  const body = Buffer.alloc(2)
  body.writeUInt16BE(code, 0)
  try { ws.write(encodeFrame('', 0x8)); ws.end() } catch (error) { /* ignore */ }
}

/** 解析客户端帧（客户端必须带 mask）；返回 { opcode, payload } 或 null */
const decodeFrames = (buffer, onFrame) => {
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let len = second & 0x7f
    let pos = offset + 2
    if (len === 126) {
      if (pos + 2 > buffer.length) return buffer.subarray(offset)
      len = buffer.readUInt16BE(pos); pos += 2
    } else if (len === 127) {
      if (pos + 8 > buffer.length) return buffer.subarray(offset)
      len = Number(buffer.readBigUInt64BE(pos)); pos += 8
    }
    const maskKey = masked ? buffer.subarray(pos, pos + 4) : null
    if (masked) pos += 4
    if (pos + len > buffer.length) return buffer.subarray(offset)
    const payload = Buffer.from(buffer.subarray(pos, pos + len))
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
    onFrame({ fin, opcode, payload })
    offset = pos + len
  }
  return buffer.subarray(offset)
}

// ---------------------------------------------------------------- 消息处理

const applyControl = (room, message) => {
  const serverNow = now()
  const playback = room.state.playback
  switch (message.type) {
    case 'PLAY':
      if (playback.trackStableKey) room.state.playback = anchorForPlay(playback, serverNow)
      break
    case 'PAUSE':
      room.state.playback = anchorForPause(playback, serverNow)
      break
    case 'SEEK':
      room.state.playback = anchorForSeek(playback, serverNow, Number(message.positionMs) || 0)
      break
    case 'SET_TRACK': {
      const track = message.track
      if (!track?.stableKey) return false
      const index = room.state.queue.findIndex(item => item.stableKey === track.stableKey)
      if (index >= 0) room.state.currentIndex = index
      else { room.state.queue.push(track); room.state.currentIndex = room.state.queue.length - 1 }
      room.state.playback = anchorForSetTrack(playback, serverNow, track.stableKey)
      break
    }
    case 'SET_QUEUE': {
      const queue = Array.isArray(message.queue) ? message.queue.slice(0, 200) : []
      room.state.queue = queue
      room.state.currentIndex = queue.length ? Math.max(0, Math.min(queue.length - 1, Number(message.currentIndex) || 0)) : -1
      const track = queue[room.state.currentIndex]
      room.state.playback = track ? anchorForSetTrack(playback, serverNow, track.stableKey) : { ...emptyPlayback(), anchorServerMs: serverNow }
      break
    }
    case 'PLAYBACK_MODE':
      room.state.playbackMode = message.mode
      break
    case 'TRACK_FINISHED': {
      if (message.trackStableKey !== playback.trackStableKey) return false
      const total = room.state.queue.length
      const current = room.state.currentIndex
      let next = -1
      if (room.state.playbackMode === 'singleLoop') next = current
      else if (room.state.playbackMode === 'listLoop') next = total ? (current + 1) % total : -1
      else if (room.state.playbackMode === 'random') next = total > 1 ? (current + 1 + Math.floor(Math.random() * (total - 1))) % total : current
      else next = current + 1 < total ? current + 1 : -1
      const track = next >= 0 ? room.state.queue[next] : null
      if (track) { room.state.currentIndex = next; room.state.playback = anchorForSetTrack(playback, serverNow, track.stableKey) }
      else room.state.playback = anchorForPause(playback, serverNow)
      break
    }
    default:
      return false
  }
  room.state.updatedAt = now()
  return true
}

const handleMessage = (room, memberId, text, ws) => {
  let message
  try { message = JSON.parse(text) } catch (error) { return sendFrame(ws, JSON.stringify({ type: 'error', code: 'bad_request', message: '不是合法 JSON' })) }
  if (!message || typeof message.type !== 'string') return sendFrame(ws, JSON.stringify({ type: 'error', code: 'bad_request', message: '缺少 type' }))

  if (message.type === 'np_ping') {
    return sendFrame(ws, JSON.stringify({ type: 'np_pong', clientNow: message.clientNow, serverNow: now(), clientId: message.clientId }))
  }

  const member = room.state.members.find(item => item.memberId === memberId)
  if (!member) return sendFrame(ws, JSON.stringify({ type: 'error', code: 'unauthorized', message: '未知成员' }))
  member.lastSeenAt = now()
  member.online = true

  if (message.type === 'HEARTBEAT') return

  if (message.type.startsWith('REQUEST_')) {
    const reject = (reason) => sendFrame(ws, JSON.stringify({ type: 'request_rejected', requestType: message.type, memberId, reason }))
    if (member.role === 'CONTROLLER') return reject('控制端直接发控制事件')
    if (!room.state.settings.allowListenerRequests) return reject('房间不允许成员请求')
    const controller = room.state.members.find(item => item.role === 'CONTROLLER')
    if (room.state.settings.requireHostOnline && !controller?.online) return reject('房主不在线')
    if (message.requestTrackStableKey !== room.state.playback.trackStableKey) return reject('requestTrackStableKey 与当前曲目不一致')
    const control = { REQUEST_PLAY: 'PLAY', REQUEST_PAUSE: 'PAUSE', REQUEST_SEEK: 'SEEK', REQUEST_SET_TRACK: 'SET_TRACK' }[message.type]
    if (!control) return reject('不支持的请求')
    if (!applyControl(room, { ...message, type: control })) return reject('房间状态不接受这次请求')
    broadcastState(room)
    return sendFrame(ws, JSON.stringify({ type: 'request_acked', requestType: message.type, memberId }))
  }

  if (member.role !== 'CONTROLLER') return sendFrame(ws, JSON.stringify({ type: 'error', code: 'forbidden', message: '只有控制端能直接控制' }))
  if (applyControl(room, message)) broadcastState(room)
}

// ---------------------------------------------------------------- 定时广播

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.sockets.size) continue
    for (const [memberId, ws] of room.sockets) {
      const member = room.state.members.find(item => item.memberId === memberId)
      if (member) member.online = !ws.destroyed
    }
    broadcastState(room)
  }
}, BROADCAST_MS).unref()

// ---------------------------------------------------------------- HTTP

const server = http.createServer(async(req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end() }

  const readBody = async() => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return {}
    try { return JSON.parse(text) } catch (error) { return {} }
  }

  if (url.pathname === '/api/rooms' && req.method === 'POST') {
    const roomId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    createRoom(roomId)
    return ok(res, { roomId })
  }

  const match = /^\/api\/rooms\/([^/]+)\/(join|state|leave)$/.exec(url.pathname)
  if (match) {
    const [, roomId, action] = match
    const room = rooms.get(roomId)
    if (!room) return err(res, 'not_found', '房间不存在', 404)

    if (action === 'state') return ok(res, { state: room.state, serverNow: now() })

    if (action === 'join') {
      await readBody()
      const onlineCount = [...room.sockets.keys()].length
      if (onlineCount >= room.state.settings.maxMembers) return err(res, 'room_full', '房间满了', 409)
      const hasController = room.state.members.some(item => item.role === 'CONTROLLER')
      const memberId = crypto.randomUUID()
      const memberSecret = crypto.randomUUID()
      const role = hasController ? 'LISTENER' : 'CONTROLLER'
      room.state.members.push({ memberId, role, online: false, joinedAt: now(), lastSeenAt: now() })
      room.secrets.set(memberId, memberSecret)
      return ok(res, {
        roomId, memberId, role, memberSecret,
        wsUrl: `ws://${req.headers.host}/api/rooms/${roomId}/ws?memberId=${memberId}&memberSecret=${encodeURIComponent(memberSecret)}`,
      })
    }

    if (action === 'leave') {
      const body = await readBody()
      if (body.memberId) {
        room.state.members = room.state.members.filter(item => item.memberId !== body.memberId)
        room.secrets.delete(body.memberId)
        const ws = room.sockets.get(body.memberId)
        if (ws) { closeFrame(ws); room.sockets.delete(body.memberId) }
        broadcast(room, { type: 'member_left', memberId: body.memberId })
        broadcastState(room)
      }
      return ok(res, { roomId })
    }
  }

  const wsMatch = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname)
  if (wsMatch) return err(res, 'bad_request', '这个路由只能用 WebSocket 升级', 426)

  return err(res, 'not_found', `no route: ${url.pathname}`, 404)
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  const wsMatch = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname)
  const reject = (code, message, status) => {
    const body = JSON.stringify({ ok: false, error: { code, message } })
    socket.write(`HTTP/1.1 ${status} Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    socket.destroy()
  }
  if (!wsMatch) return reject('not_found', 'no route', 404)

  const room = rooms.get(wsMatch[1])
  if (!room) return reject('not_found', '房间不存在', 404)

  const memberId = url.searchParams.get('memberId') ?? ''
  const secret = url.searchParams.get('memberSecret') ?? ''
  if (!memberId || room.secrets.get(memberId) !== secret) return reject('unauthorized', 'memberSecret 不匹配', 401)
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return reject('bad_request', 'expected websocket upgrade', 400)

  const member = room.state.members.find(item => item.memberId === memberId)
  if (!member) return reject('not_found', '成员不存在，请重新 join', 404)

  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'))

  socket.setNoDelay(true)
  member.online = true
  room.sockets.set(memberId, socket)

  sendFrame(socket, JSON.stringify({ type: 'room_state_updated', state: room.state, serverNow: now() }))
  broadcast(room, { type: 'member_joined', memberId, role: member.role })
  broadcastState(room)

  let buffer = Buffer.alloc(0)
  const onData = chunk => {
    buffer = Buffer.concat([buffer, chunk])
    buffer = decodeFrames(buffer, ({ opcode, payload }) => {
      if (opcode === 0x1) handleMessage(room, memberId, payload.toString('utf8'), socket)
      else if (opcode === 0x9) socket.write(encodeFrame(payload.toString('utf8'), 0xA))
      else if (opcode === 0x8) { closeFrame(socket); socket.end() }
    })
  }
  if (head?.length) onData(head)
  socket.on('data', onData)

  const onGone = () => {
    if (room.sockets.get(memberId) !== socket) return
    room.sockets.delete(memberId)
    const current = room.state.members.find(item => item.memberId === memberId)
    if (current) { current.online = false; current.lastSeenAt = now() }
    broadcast(room, { type: 'member_left', memberId })
    broadcastState(room)
  }
  socket.on('close', onGone)
  socket.on('error', onGone)
})

server.listen(PORT, HOST, () => {
  console.log(`一起听本机服务已启动：http://${HOST}:${PORT}`)
  console.log('App 里：设置 → 一起听 → 服务器地址填上面这个地址（局域网另一台手机用 http://<本机IP>:' + PORT + '）')
})
