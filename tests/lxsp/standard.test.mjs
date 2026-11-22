/** 标准 API 模式：只填 API_URL + API_KEY 就能用（POST /music/url + X-Api-Key） */
import http from 'node:http'
import { probeStandardApi, StandardApiProvider, STANDARD_SOURCES } from '../../src/core/source/standard-api.ts'
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

const API = ({ url, method, headers, body, send }) => {
  if (url.pathname !== '/music/url' || method !== 'POST') return send(404, { code: 404, message: 'not found' })
  if (headers['x-api-key'] !== 'KEY-OK') return send(200, { code: 403, message: '鉴权失败' })
  if (body.musicId === 'vip') return send(200, { code: 500, message: '无版权' })
  if (body.musicId === 'none') return send(200, { code: 500, message: '未找到该歌曲' })
  if (body.musicId === 'oops') return send(500, { message: '服务器炸了' })
  return send(200, { code: 200, url: `http://cdn/${body.source}/${body.musicId}/${body.quality}.mp3` })
}

export default (t) => {
  t.suite('探测：/music/url 存在就认（带回 code/message/url 的 JSON）', async() => {
    const { server, port } = await start(API)
    const probe = await probeStandardApi({ baseUrl: `http://127.0.0.1:${port}`, token: 'KEY-OK', fetchImpl: fetch })
    t.ok(probe, '认出来了')
    t.eq(probe.baseUrl, `http://127.0.0.1:${port}`)
    server.close()
  })

  t.suite('探测：不是这套接口就返回 null（不瞎猜）', async() => {
    const { server, port } = await start(({ send }) => send(404, { error: 'nope' }))
    t.eq(await probeStandardApi({ baseUrl: `http://127.0.0.1:${port}`, fetchImpl: fetch }), null)
    server.close()
  })

  t.suite('取直链：POST /music/url + X-Api-Key + body 里带 source/musicId/quality', async() => {
    const { server, port } = await start(API)
    const probe = await probeStandardApi({ baseUrl: `http://127.0.0.1:${port}`, token: 'KEY-OK', fetchImpl: fetch })
    const provider = new StandardApiProvider({ probe, source: STANDARD_SOURCES[0], token: 'KEY-OK', priority: 0, fetchImpl: fetch })
    const result = await provider.resolveUrl({ source: 'kg', id: 'abc123', quality: 'flac' })
    t.eq(result.url, 'http://cdn/kg/abc123/flac.mp3')
    t.eq(result.quality, 'flac')
    server.close()
  })

  t.suite('错误归一：403→unauthorized、无版权→upstream_denied、未找到→not_found、500→upstream_error', async() => {
    const { server, port } = await start(API)
    const probe = await probeStandardApi({ baseUrl: `http://127.0.0.1:${port}`, token: 'KEY-OK', fetchImpl: fetch })
    const make = (token) => new StandardApiProvider({ probe, source: STANDARD_SOURCES[1], token, priority: 0, fetchImpl: fetch })
    await t.rejects(() => make('WRONG').resolveUrl({ source: 'kw', id: '1', quality: '320k' }), 'unauthorized', '密钥错')
    await t.rejects(() => make('KEY-OK').resolveUrl({ source: 'kw', id: 'vip', quality: '320k' }), 'upstream_denied', '无版权')
    await t.rejects(() => make('KEY-OK').resolveUrl({ source: 'kw', id: 'none', quality: '320k' }), 'not_found', '没找到')
    await t.rejects(() => make('KEY-OK').resolveUrl({ source: 'kw', id: 'oops', quality: '320k' }), 'upstream_error', '500')
    server.close()
  })

  t.suite('引擎：API_URL 不是 LXSP 时自动走 API 模式，填两格就能播', async() => {
    const { server, port } = await start(API)
    const engine = new SourceEngine()
    const result = await engine.init({ endpoints: [{ baseUrl: `http://127.0.0.1:${port}`, token: 'KEY-OK' }] })
    t.eq(result.ok, true, '有可播源')
    t.eq(result.endpoints[0].ok, true)
    t.eq(result.endpoints[0].provider, 'API 模式', '识别成 API 模式')
    t.eq(result.sources.sort(), ['kg', 'kw', 'mg', 'tx', 'wy'], '五个源都在')
    const played = await engine.apis('kg').getMusicUrl({ songmid: 'abc123' }, 'flac').promise
    t.eq(played.url, 'http://cdn/kg/abc123/flac.mp3')
    server.close()
  })
}
