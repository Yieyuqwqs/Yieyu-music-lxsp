/** 旧脚本后端兼容：三族接口都能靠 API_URL + API_KEY 用起来（LXSP v2 仍然优先） */
import http from 'node:http'
import { probeApiProfiles, ApiProfileProvider } from '../../src/core/source/api-profiles.ts'
import { SourceEngine } from '../../src/core/source/engine.ts'

const start = (handler) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      let body = null
      try { body = raw ? JSON.parse(raw) : null } catch (e) {}
      handler({ url, method: req.method, headers: req.headers, body, send: (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      } })
    })
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
})

/** wwwweb 族 */
const wwwweb = ({ url, method, headers, body, send }) => {
  if (url.pathname === '/music/url' && method === 'POST') {
    if (headers['x-api-key'] !== 'KEY') return send(200, { code: 403, message: '鉴权失败' })
    return send(200, { code: 200, url: `http://cdn/wwwweb/${body.source}/${body.musicId}/${body.quality}.mp3` })
  }
  return send(404, { code: 404, message: 'not found' })
}

/** lx-source 族（自述 + /api/v0/*） */
const lxSource = ({ url, headers, send }) => {
  if (url.pathname === '/api/v0/') {
    return send(200, { version: '1.1.17', source: { wy: ['128k', '320k', 'flac'], kg: null, kw: ['320k'] }, auth: { apikey: true } })
  }
  if (url.pathname.startsWith('/api/v0/url/')) {
    if (url.searchParams.get('key') !== 'KEY') return send(403, { code: 403, msg: '密钥验证失败' })
    return send(200, { code: 0, data: 'http://cdn/lxsrc/a.flac', ext: { qual: 'flac', expi: 1800000000 } })
  }
  if (url.pathname.startsWith('/api/v0/lrc/')) return send(200, { code: 0, data: '[00:00.00]词' })
  if (url.pathname.startsWith('/api/v0/pic/')) return send(200, { code: 0, data: 'http://cdn/p.jpg' })
  return send(404, { code: 404, msg: 'nope' })
}

/** 通用 JSON 族 */
const apiJson = ({ url, method, body, send }) => {
  if (url.pathname === '/api/parse' && method === 'POST') {
    return send(200, { code: 0, data: { url: `http://cdn/json/${body.id}.flac` } })
  }
  if (url.pathname.startsWith('/url/')) return send(200, { url: 'http://cdn/json/fallback.mp3' })
  return send(404, { message: 'not found' })
}

export default (t) => {
  t.suite('认出 wwwweb 族，并用 X-Api-Key 取直链', async() => {
    const { server, port } = await start(wwwweb)
    const probe = await probeApiProfiles({ baseUrl: `http://127.0.0.1:${port}`, token: 'KEY', fetchImpl: fetch })
    t.eq(probe.profile, 'api-wwwweb')
    const provider = new ApiProfileProvider({ probe, source: probe.sources[0], token: 'KEY', priority: 0, fetchImpl: fetch })
    const result = await provider.resolveUrl({ source: 'kg', id: 'abc', quality: 'flac' })
    t.eq(result.url, 'http://cdn/wwwweb/kg/abc/flac.mp3')
    server.close()
  })

  t.suite('认出 lx-source 族：音源表来自自述，直链带 ext.qual', async() => {
    const { server, port } = await start(lxSource)
    const probe = await probeApiProfiles({ baseUrl: `http://127.0.0.1:${port}`, token: 'KEY', fetchImpl: fetch })
    t.eq(probe.profile, 'lx-source')
    t.eq(probe.sources.map(s => s.key), ['wy', 'kw'], 'kg=null 被跳过')
    const provider = new ApiProfileProvider({ probe, source: probe.sources[0], token: 'KEY', priority: 0, fetchImpl: fetch })
    const result = await provider.resolveUrl({ source: 'wy', id: '1912598037', quality: 'flac' })
    t.eq(result.url, 'http://cdn/lxsrc/a.flac')
    t.eq(result.quality, 'flac')
    t.eq(result.expiresAt, 1800000000)
    t.eq((await provider.lyric({ source: 'wy', id: '1' })).lrc, '[00:00.00]词')
    t.eq(await provider.pic({ source: 'wy', id: '1' }), 'http://cdn/p.jpg')
    server.close()
  })

  t.suite('认出通用 JSON 族（/api/parse），并支持嵌套 data.url', async() => {
    const { server, port } = await start(apiJson)
    const probe = await probeApiProfiles({ baseUrl: `http://127.0.0.1:${port}`, token: 'KEY', fetchImpl: fetch })
    t.eq(probe.profile, 'api-json')
    const provider = new ApiProfileProvider({ probe, source: probe.sources[0], token: 'KEY', priority: 0, fetchImpl: fetch })
    const result = await provider.resolveUrl({ source: 'kw', id: '42', quality: '320k' })
    t.eq(result.url, 'http://cdn/json/42.flac', '从 data.url 里取到')
    server.close()
  })

  t.suite('错误归一：任何一族的鉴权失败都是 unauthorized', async() => {
    const { server, port } = await start(wwwweb)
    const probe = await probeApiProfiles({ baseUrl: `http://127.0.0.1:${port}`, token: 'KEY', fetchImpl: fetch })
    const provider = new ApiProfileProvider({ probe, source: probe.sources[0], token: 'WRONG', priority: 0, fetchImpl: fetch })
    await t.rejects(() => provider.resolveUrl({ source: 'kg', id: '1', quality: '320k' }), 'unauthorized')
    server.close()
  })

  t.suite('引擎：API_URL 填 wwwweb 地址，两格就能播', async() => {
    const { server, port } = await start(wwwweb)
    const engine = new SourceEngine()
    const result = await engine.init({ endpoints: [{ baseUrl: `http://127.0.0.1:${port}`, token: 'KEY' }] })
    t.eq(result.ok, true)
    t.eq(result.endpoints[0].provider, 'api-wwwweb')
    const played = await engine.apis('kg').getMusicUrl({ songmid: 'abc' }, 'flac').promise
    t.eq(played.url, 'http://cdn/wwwweb/kg/abc/flac.mp3')
    server.close()
  })

  t.suite('引擎：LXSP v2 优先，不会被旧接口层抢走', async() => {
    const { server, port } = await start(({ url, send }) => {
      if (url.pathname === '/manifest') {
        return send(200, { ok: true, data: { lxsp: '2.0', provider: { id: 'p', name: 'P', version: '1' }, sources: [{ key: 'kw', name: 'K', qualities: ['320k'] }] } })
      }
      return send(404, { code: 404 })
    })
    const engine = new SourceEngine()
    const result = await engine.init({ endpoints: [{ baseUrl: `http://127.0.0.1:${port}` }] })
    t.eq(result.endpoints[0].ok, true)
    t.eq(result.endpoints[0].provider, 'P', '走的是 LXSP manifest，不是旧接口层')
    server.close()
  })
}
