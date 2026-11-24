/**
 * Cloudflare Worker 入口：翻译 HTTP → Durable Object 调用。
 *
 *   POST /api/rooms                 建房 → { roomId }
 *   POST /api/rooms/:id/join        加入 → { memberId, role, memberSecret, wsUrl }
 *   GET  /api/rooms/:id/state       快照 → { state, serverNow }
 *   POST /api/rooms/:id/leave       显式离开
 *   GET  /api/rooms/:id/ws?...      WebSocket 升级（转发给 DO）
 */
import type { ApiEnvelope, CreateRoomResponse } from './protocol'

export interface Env {
  ROOMS: DurableObjectNamespace
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const json = <T>(body: ApiEnvelope<T>, status = 200): Response => (
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  })
)

const roomIdPattern = /^[a-zA-Z0-9_-]{6,64}$/

const stubFor = (env: Env, roomId: string): DurableObjectStub => env.ROOMS.get(env.ROOMS.idFromName(roomId))

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const roomId = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      const stub = stubFor(env, roomId)
      // 让 DO 记住自己的房间号（DO 的 id 是内部哈希，不是这个可读 id）
      const init = await stub.fetch(`https://room/init?roomId=${roomId}`, { method: 'POST' })
      if (!init.ok) return json({ ok: false, error: { code: 'internal', message: '建房失败' } }, 500)
      const data: CreateRoomResponse = { roomId }
      return json({ ok: true, data })
    }

    const match = /^\/api\/rooms\/([^/]+)\/(join|state|leave|ws)$/.exec(url.pathname)
    if (match) {
      const [, roomId, action] = match
      if (!roomIdPattern.test(roomId)) return json({ ok: false, error: { code: 'bad_request', message: 'roomId 不合法' } }, 400)
      const stub = stubFor(env, roomId)

      if (action === 'ws') {
        // WebSocket 必须原样转发（含 Upgrade 头）
        return stub.fetch(`https://room/ws${url.search}`, { headers: request.headers })
      }
      if (action === 'state') {
        if (request.method !== 'GET') return json({ ok: false, error: { code: 'bad_request', message: 'use GET' } }, 405)
        return stub.fetch('https://room/snapshot')
      }
      if (request.method !== 'POST') return json({ ok: false, error: { code: 'bad_request', message: 'use POST' } }, 405)
      const body = await request.text()
      return stub.fetch(`https://room/${action}`, { method: 'POST', body })
    }

    return json({ ok: false, error: { code: 'not_found', message: `no route: ${url.pathname}` } }, 404)
  },
}

export { ListeningRoomDO } from './room-do'
