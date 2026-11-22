/** 引擎装配：manifest → Provider → 旧调用面（apis/getMusicUrl/getLyric/getPic）+ 搜索转换 */
import http from 'node:http'
import { sourceEngine, SourceEngine, parseEndpoints } from '../../src/core/source/engine.ts'
import { toLegacyMusicItem, extractTrackId, msToInterval } from '../../src/core/source/local.ts'

const manifest = {
  lxsp: '2.0',
  provider: { id: 'engine-test', name: 'Engine Test', version: '2.0.0' },
  capabilities: ['url', 'lyric', 'pic', 'search'],
  sources: [
    { key: 'kw', name: '酷我音乐', qualities: ['flac', '320k', '128k'] },
    { key: 'kg', name: '酷狗音乐', qualities: ['flac24bit', 'flac', '320k', '128k'] },
  ],
}

const startServer = () => new Promise((resolve) => {
  const calls = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = payload => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }
    calls.push(url.pathname)
    if (url.pathname === '/manifest') return send({ ok: true, data: manifest })
    if (url.pathname.startsWith('/url/')) {
      const requested = url.searchParams.get('quality')
      return send({ ok: true, data: { url: 'http://cdn/x.mp3', source: 'kw', id: '42', quality: requested === 'flac' ? '320k' : '320k', requestedQuality: requested, downgraded: false } })
    }
    if (url.pathname.startsWith('/lyric/')) return send({ ok: true, data: { lrc: '[00:00.00]词', tlrc: '[00:00.00]trans' } })
    if (url.pathname.startsWith('/pic/')) return send({ ok: true, data: { url: 'http://cdn/p.jpg' } })
    if (url.pathname === '/search') {
      return send({ ok: true, data: { items: [{ id: '7', name: '屋顶', singer: '周杰伦/温岚', album: '叶惠美', durationMs: 225000, qualities: { flac: { size: 1 } } }], page: 1, limit: 10, total: 1, hasMore: false } })
    }
    send({ ok: false, error: { code: 'not_found', message: 'no route' } })
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port }))
})

export default (t) => {
  let server
  let port
  let calls

  t.suite('引擎装配：一次 init 得到 Provider 表与 qualityList', async() => {
    const started = await startServer()
    server = started.server
    calls = started.calls
    port = started.port
    const result = await sourceEngine.init({
      endpoints: [{ baseUrl: `http://127.0.0.1:${port}`, token: null }],
    })
    t.eq(result.ok, true, '端点可用')
    t.eq(result.sources.sort(), ['kg', 'kw'], '音源投影')
    t.eq(sourceEngine.qualityList().kw, ['flac', '320k', '128k'], 'qualityList 只含 LX 词汇')
    t.eq(sourceEngine.hasUrlProvider('kw'), true)
    t.eq(sourceEngine.hasUrlProvider('local'), false, 'local 不该有 url provider')
  })

  t.suite('旧调用面：getMusicUrl 返回 {promise, canceleFn}，降档由引擎补报', async() => {
    const api = sourceEngine.apis('kw')
    const handle = api.getMusicUrl({ songmid: '42', name: '忘情水', singer: '刘德华' }, 'flac')
    t.eq(typeof handle.promise?.then, 'function', '有 promise')
    t.eq(typeof handle.canceleFn, 'function', '有 canceleFn')
    const result = await handle.promise
    t.eq(result.type, '320k', '回填实际音质')
    t.eq(result.url, 'http://cdn/x.mp3')
    t.eq(result.downgraded, true, '请求 flac 实际 320k → 降档')
  })

  t.suite('旧调用面：getLyric / getPic 字段对齐 App 期望', async() => {
    const lyric = await sourceEngine.apis('kw').getLyric({ songmid: '42' }).promise
    t.eq([lyric.lyric, lyric.tlyric, lyric.rlyric, lyric.lxlyric], ['[00:00.00]词', '[00:00.00]trans', '', ''], '四个字段齐全')
    const pic = await sourceEngine.apis('kg').getPic({ hash: '42' }).promise
    t.eq(pic, 'http://cdn/p.jpg')
  })

  t.suite('搜索：返回 toNewMusicInfo 能吃的旧形状', async() => {
    const result = await sourceEngine.search('kw', '屋顶', 1, 10)
    t.eq(result.total, 1)
    const item = result.list[0]
    t.eq(item.songmid, '7', 'id 落到 songmid')
    t.eq(item.interval, '03:45', '毫秒转 mm:ss')
    t.eq(item._types.flac.size, 1, '_types 带音质信息')
    t.eq(item.types[0].type, 'flac', 'types 带档位')
    t.eq(item.source, 'kw')
  })

  t.suite('端点配置解析：换行/逗号分隔与 url|token 内联', () => {
    t.eq(parseEndpoints('http://127.0.0.1:1101'), [{ baseUrl: 'http://127.0.0.1:1101', token: null }])
    t.eq(parseEndpoints('http://a\nhttp://b|lx_1', 'fallback'), [
      { baseUrl: 'http://a', token: 'fallback' },
      { baseUrl: 'http://b', token: 'lx_1' },
    ])
    t.eq(parseEndpoints('  ,  \n http://c '), [{ baseUrl: 'http://c', token: null }])
    t.eq(parseEndpoints('not-a-url'), [], '非 http 直接丢弃')
  })

  t.suite('纯 LXSP：端点全挂时没有任何音源，就老实报不可用', async() => {
    const engine = new SourceEngine()
    const result = await engine.init({ endpoints: [{ baseUrl: 'http://127.0.0.1:1' }] })
    t.eq(result.ok, false, '没有可播源 → ok=false')
    t.eq(result.qualityList, {}, 'qualityList 为空，界面不会假装能播')
    t.eq(engine.registryInstance.size, 0, '不再有任何内置兜底源')
    t.eq(result.endpoints[0].ok, false)
    const message = String(result.endpoints[0].error || '')
    t.ok(message.includes('network'), '死端口应报 network：' + message)
  })

  t.suite('纯 LXSP：填了不是 LXSP 的地址，要说清「缺 /manifest」而不是干巴巴 404', async() => {
    const server = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' })
      res.end('<html>old service</html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const engine = new SourceEngine()
    const result = await engine.init({ endpoints: [{ baseUrl: `http://127.0.0.1:${server.address().port}` }] })
    server.close()
    t.eq(result.ok, false)
    const message = String(result.endpoints[0].error || '')
    t.ok(message.includes('LXSP'), '要提示缺 /manifest：' + message)
  })

  t.suite('工具函数：id 提取、时长格式化', () => {
    t.eq(extractTrackId({ hash: 'abc' }), 'abc')
    t.eq(extractTrackId({ songmid: '123' }), '123', 'songmid 优先')
    t.eq(extractTrackId({ copyrightId: 'mg1' }), 'mg1')
    t.eq(extractTrackId({}), '')
    t.eq(msToInterval(225000), '03:45')
    t.eq(msToInterval(null), '00:00')
    const item = toLegacyMusicItem('kg', { id: '9', name: 'n', singer: 's', durationMs: 60000 }, ['128k'])
    t.eq([item.songmid, item.hash, item.interval, item.types[0].type], ['9', '9', '01:00', '128k'])
  })

  t.suite('清理：关闭服务', async() => {
    await new Promise(resolve => server.close(resolve))
    t.ok(calls.length > 0, '确实打过服务端')
  })
}
