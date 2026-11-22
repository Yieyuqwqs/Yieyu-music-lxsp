/** 旧版 LX 音源 API 适配：探测 / 直链 / 密钥 / 错误码 / 引擎自动识别（这就是「只填 API+密钥」） */
import http from 'node:http'
import { probeLegacyApi, LegacyApiProvider } from '../../src/core/source/legacy-api.ts'
import { SourceEngine } from '../../src/core/source/engine.ts'

const startServer = (handler) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      let body = null
      try { body = raw ? JSON.parse(raw) : null } catch (e) {}
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      handler({ url, method: req.method, headers: req.headers, body, send, req })
    })
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
})

/** lx-source-next 形态 */
const nextHandler = ({ url, headers, send }) => {
  if (url.pathname === '/api/v0/') {
    return send(200, {
      version: '1.1.17', name: 'lx-music-source',
      source: { wy: ['128k', '320k', 'flac'], kg: null, kw: ['128k', '320k'], tx: ['flac24bit'] },
      auth: { apikey: true },
    })
  }
  if (url.pathname.startsWith('/api/v0/url/')) {
    if (url.searchParams.get('key') !== 'secret') return send(403, { code: 403, msg: '密钥验证失败', data: null })
    return send(200, { code: 0, msg: '', data: 'http://cdn/x.flac', ext: { qual: 'flac24bit', expi: 1_800_000_000 } })
  }
  if (url.pathname.startsWith('/api/v0/lrc/')) return send(200, { code: 0, msg: '', data: '[00:00.00]词' })
  if (url.pathname.startsWith('/api/v0/pic/')) return send(200, { code: 0, msg: '', data: 'http://cdn/p.jpg' })
  return send(404, { code: 404, msg: '404 page not found' })
}

/** wwwweb 形态 */
const wwwwebHandler = ({ url, method, headers, body, send }) => {
  if (url.pathname === '/music/url' && method === 'POST') {
    if (headers['x-api-key'] !== 'secret') return send(200, { code: 403, message: '鉴权失败' })
    return send(200, { code: 200, url: 'http://cdn/w.mp3', msg: '' })
  }
  return send(404, { code: 404, message: '404 page not found' })
}

export default (t) => {
  t.suite('探测 lx-source-next：读出真实音源与音质（kg 为 null 要跳过）', async() => {
    const { server, port } = await startServer(nextHandler)
    const probe = await probeLegacyApi({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret', fetchImpl: fetch })
    t.ok(probe, '探测成功')
    t.eq(probe.flavor, 'lx-source-next')
    t.eq(probe.sources.map(s => s.key), ['wy', 'kw', 'tx'], 'kg 是 null 被跳过')
    t.eq(probe.sources[0].qualities, ['flac', '320k', '128k'], '音质降序归一')
    t.eq(probe.needKey, true)
    t.eq(probe.version, '1.1.17')
    server.close()
  })

  t.suite('探测 wwwweb：没有自述接口也能认出（POST /music/url 存在即可）', async() => {
    const { server, port } = await startServer(wwwwebHandler)
    const probe = await probeLegacyApi({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret', fetchImpl: fetch })
    t.ok(probe, '探测成功')
    t.eq(probe.flavor, 'wwwweb')
    t.eq(probe.sources.map(s => s.key), ['kg', 'kw', 'tx', 'wy', 'mg'])
    server.close()
  })

  t.suite('探测不认识的服务：返回 null，不瞎猜', async() => {
    const { server, port } = await startServer(({ send }) => send(404, { error: 'nope' }))
    const probe = await probeLegacyApi({ baseUrl: `http://127.0.0.1:${port}`, token: null, fetchImpl: fetch })
    t.eq(probe, null)
    server.close()
  })

  t.suite('lx-source-next 取直链：key 走 query，真实音质来自 ext.qual', async() => {
    const { server, port } = await startServer(nextHandler)
    const probe = await probeLegacyApi({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret', fetchImpl: fetch })
    const provider = new LegacyApiProvider({ probe, source: probe.sources[0], token: 'secret', priority: 0, fetchImpl: fetch })
    t.eq(provider.meta.qualities, ['flac', '320k', '128k'])
    t.eq(provider.supports('url'), true)
    t.eq(provider.supports('search'), false, '旧接口没有搜索能力')
    const result = await provider.resolveUrl({ source: 'wy', id: '1912598037', quality: 'flac' })
    t.eq(result.url, 'http://cdn/x.flac')
    t.eq(result.quality, 'flac24bit', '按上游回报的真实音质')
    t.eq(result.expiresAt, 1_800_000_000)
    const lyric = await provider.lyric({ source: 'wy', id: '1912598037' })
    t.eq(lyric.lrc, '[00:00.00]词')
    server.close()
  })

  t.suite('密钥错：翻译成 unauthorized（换源无效，需要改配置）', async() => {
    const { server, port } = await startServer(nextHandler)
    const probe = await probeLegacyApi({ baseUrl: `http://127.0.0.1:${port}`, token: 'wrong', fetchImpl: fetch })
    const provider = new LegacyApiProvider({ probe, source: probe.sources[0], token: 'wrong', priority: 0, fetchImpl: fetch })
    await t.rejects(() => provider.resolveUrl({ source: 'wy', id: '1', quality: '320k' }), 'unauthorized', '403 → unauthorized')
    server.close()
  })

  t.suite('wwwweb 取直链：POST /music/url + X-Api-Key', async() => {
    const { server, port } = await startServer(wwwwebHandler)
    const probe = await probeLegacyApi({ baseUrl: `http://127.0.0.1:${port}`, token: 'secret', fetchImpl: fetch })
    const provider = new LegacyApiProvider({ probe, source: probe.sources[0], token: 'secret', priority: 0, fetchImpl: fetch })
    const result = await provider.resolveUrl({ source: 'kw', id: '62355680', quality: '320k' })
    t.eq(result.url, 'http://cdn/w.mp3')
    t.eq(result.quality, '320k')
    server.close()
  })

  t.suite('引擎自动识别：填一个旧版 API 端点，不报 404，直接可播', async() => {
    const { server, port } = await startServer(nextHandler)
    const engine = new SourceEngine()
    const result = await engine.init({
      endpoints: [{ baseUrl: `http://127.0.0.1:${port}`, token: 'secret' }],
      enableLegacy: false,
    })
    t.eq(result.ok, true, '有可播源')
    t.eq(result.endpoints[0].ok, true)
    t.eq(result.endpoints[0].flavor, 'legacy-api', '识别成旧版 API 而不是 LXSP')
    t.eq(Object.keys(result.qualityList).sort(), ['kw', 'tx', 'wy'], '源表来自上游自述')
    const played = await engine.apis('wy').getMusicUrl({ songmid: '1912598037' }, 'flac').promise
    t.eq(played.url, 'http://cdn/x.flac')
    t.eq(played.type, 'flac24bit')
    server.close()
  })
}
