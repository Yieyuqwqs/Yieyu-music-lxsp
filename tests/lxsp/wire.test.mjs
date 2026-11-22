/** 线格式联调：起一个真 HTTP 的 LXSP 服务端，用 App 里的客户端代码打过去 */
import http from 'node:http'
import { LxspTransport } from '../../src/core/source/transport.ts'
import { RemoteProvider } from '../../src/core/source/remote.ts'
import { SourceRegistry } from '../../src/core/source/registry.ts'
import { SourceResolver } from '../../src/core/source/resolver.ts'
import { parseManifest } from '../../src/core/source/manifest.ts'
import { LxspError } from '../../src/core/source/errors.ts'

const MANIFEST = {
  lxsp: '2.0',
  provider: { id: 'test-gw', name: 'Test Gateway', version: '9.9.9' },
  auth: { required: true, scheme: 'bearer' },
  capabilities: ['url', 'lyric', 'pic', 'search'],
  features: { streamProxy: true, crossSource: true },
  limits: { timeoutMs: 3000 },
  sources: [
    { key: 'kw', name: '酷我音乐', qualities: ['flac', '320k', '128k'], idFormat: 'uint' },
    { key: 'kg', name: '酷狗音乐', qualities: ['flac24bit', 'flac', '320k', '128k'] },
  ],
}

const json = (res, status, payload) => {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

const startServer = () => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const auth = req.headers.authorization ?? ''
    if (url.pathname !== '/healthz' && auth !== 'Bearer good-token') {
      return json(res, 401, { ok: false, error: { code: 'unauthorized', message: 'bad token' } })
    }

    if (url.pathname === '/manifest') return json(res, 200, { ok: true, data: MANIFEST })
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, data: { status: 'ok', version: '9.9.9', sources: { kw: 'ok' } } })

    if (url.pathname.startsWith('/url/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop())
      const requested = url.searchParams.get('quality') ?? 'auto'
      if (id === 'denied') return json(res, 200, { ok: false, error: { code: 'upstream_denied', message: 'VIP only', source: 'kw', quality: requested } })
      if (id === 'slow') return setTimeout(() => json(res, 200, { ok: true, data: { url: 'http://cdn/slow.flac', source: 'kw', id, quality: 'flac', requestedQuality: requested, downgraded: false } }), 300)
      if (id === 'garbage') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end('<html>not json</html>')
      }
      return json(res, 200, {
        ok: true,
        trace: 'trace-1',
        data: {
          url: 'http://cdn/direct.flac',
          streamUrl: 'http://127.0.0.1/stream/abc',
          source: 'kw',
          id,
          quality: '320k',
          requestedQuality: requested,
          downgraded: true,
          expiresAt: 1_800_000_000,
          via: { upstream: 'kuwo', cache: 'l1', coalesced: false },
        },
      })
    }

    if (url.pathname.startsWith('/lyric/')) {
      return json(res, 200, { ok: true, data: { lrc: '[00:01.00]东风破', tlrc: '[00:01.00]East Wind Breaks', format: 'lrc' } })
    }
    if (url.pathname.startsWith('/pic/')) {
      return json(res, 200, { ok: true, data: { url: 'http://cdn/cover.jpg', width: 300, height: 300 } })
    }
    if (url.pathname === '/search') {
      return json(res, 200, {
        ok: true,
        data: {
          items: [
            { id: '1', name: '东风破', singer: '周杰伦', album: '叶惠美', durationMs: 313_000, qualities: { flac: { size: 30_000_000 } } },
            { id: '', name: '脏数据（没有 id）', singer: 'x' },
            { id: '2', singer: '' },
            { id: '3', name: '以父之名', singer: '周杰伦', durationMs: 336_000 },
          ],
          page: 1,
          limit: 20,
          total: 4,
          hasMore: false,
        },
      })
    }
    return json(res, 404, { ok: false, error: { code: 'not_found', message: 'no route' } })
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
})

export default (t) => {
  let server
  let port
  let baseUrl
  let transport
  let manifest
  let provider

  t.suite('联调准备：起 HTTP 服务并完成 manifest 握手', async() => {
    const started = await startServer()
    server = started.server
    port = started.port
    baseUrl = `http://127.0.0.1:${port}`
    transport = new LxspTransport({ baseUrl, token: 'good-token' })
    const raw = await transport.getJson('/manifest')
    manifest = parseManifest(raw)
    t.eq(manifest.provider.id, 'test-gw')
    provider = new RemoteProvider({ transport, manifest, source: manifest.sources[0], priority: 0 })
    t.eq(provider.meta.qualities, ['flac', '320k', '128k'], 'Provider 继承声明的音质')
    t.eq(provider.supports('url'), true)
  })

  t.suite('信封：ok=true 时取出 data，ok=false 时翻译成协议错误码', async() => {
    const data = await transport.getJson('/url/kw/42', { quality: 'flac' })
    t.eq(data.source, 'kw')
    const error = await t.rejects(() => transport.getJson('/url/kw/denied', { quality: 'flac' }), 'upstream_denied', 'VIP 拒绝')
    t.eq(error.source, 'kw', '错误体里的音源被保留')
    t.eq(error.quality, 'flac', '错误体里的音质被保留')
  })

  t.suite('鉴权：401 翻译成 unauthorized（换源无效，需要改配置）', async() => {
    const bad = new LxspTransport({ baseUrl, token: 'wrong-token' })
    await t.rejects(() => bad.getJson('/manifest'), 'unauthorized', '401')
  })

  t.suite('协议校验：返回非 JSON 必须报 bad_response，不许当成功', async() => {
    await t.rejects(() => transport.getJson('/url/kw/garbage'), 'bad_response', 'HTML 冒充 JSON')
  })

  t.suite('超时：慢端点按 timeout 收口，返回 timeout 错误码', async() => {
    const error = await t.rejects(() => transport.getJson('/url/kw/slow', {}, { timeoutMs: 60 }), 'timeout', '超时')
    t.ok(error.message.includes('60ms'), '错误信息带超时配置')
  })

  t.suite('Provider 翻译：直链优先 streamUrl，降档由客户端复核', async() => {
    const result = await provider.resolveUrl({ source: 'kw', id: '42', quality: 'flac' })
    t.eq(result.url, 'http://cdn/direct.flac')
    t.eq(result.streamUrl, 'http://127.0.0.1/stream/abc', '代理流地址被保留')
    t.eq(result.quality, '320k')
    t.eq(result.downgraded, true, '请求 flac 给 320k → 降档')
    t.eq(result.via.upstream, 'kuwo')
  })

  t.suite('歌词/封面：字段映射到 App 内部形状', async() => {
    const lyric = await provider.lyric({ source: 'kw', id: '42' })
    t.eq(lyric.lrc, '[00:01.00]东风破')
    t.eq(lyric.tlrc, '[00:01.00]East Wind Breaks')
    const pic = await provider.pic({ source: 'kg', id: '42' })
    t.eq(pic, 'http://cdn/cover.jpg')
  })

  t.suite('搜索：脏数据单条丢弃，不影响整页', async() => {
    const result = await provider.search({ text: '周杰伦', page: 1, limit: 20 })
    t.eq(result.items.map(item => item.id), ['1', '3'], '没有 id / 没有名字的被丢掉')
    t.eq(result.items[0].name, '东风破')
    t.eq(result.total, 4)
  })

  t.suite('健康探测：/healthz 可达', async() => {
    const health = await provider.health({})
    t.eq(health.status, 'ok')
  })

  t.suite('端到端：resolver + 远端 Provider，VIP 拒绝后自动换源', async() => {
    const registry = new SourceRegistry()
    registry.add(provider)
    const mirror = {
      meta: {
        id: 'mirror', providerId: 'mirror', name: 'Mirror', version: '1', kind: 'lxsp', source: 'kw',
        priority: 10, qualities: ['320k'], capabilities: ['url'],
      },
      supports: cap => cap === 'url',
      resolveUrl: async(query) => ({ url: 'http://mirror/42.mp3', quality: '320k', requestedQuality: query.quality, downgraded: true }),
      lyric: async() => ({ lrc: '' }),
      pic: async() => '',
      search: async() => ({ items: [], page: 1, limit: 10, hasMore: false }),
    }
    registry.add(mirror)
    const resolver = new SourceResolver({ registry })
    const result = await resolver.resolveUrl({ source: 'kw', id: 'denied', quality: 'flac' })
    t.eq(result.provider.id, 'mirror', '主端点被 VIP 拒绝后换到镜像')
    t.eq(result.attempts[0].code, 'upstream_denied', '第一次失败被记录')
  })

  t.suite('清理：关闭测试服务', async(  ) => {
    await new Promise(resolve => server.close(resolve))
    t.ok(true)
  })
}
