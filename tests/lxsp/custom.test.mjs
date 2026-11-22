/** 通用 API 源：JSONPath 提取 + 请求模板 + 鉴权位置 + 引擎注册 */
import http from 'node:http'
import { pick, pickString } from '../../src/core/source/jsonpath.ts'
import { parseCustomSources, CustomApiProvider } from '../../src/core/source/custom-source.ts'
import { SourceEngine } from '../../src/core/source/engine.ts'

const PAYLOAD = {
  code: 0,
  msg: 'ok',
  data: { url: 'http://cdn/a.flac', quality: 'flac', exp: 1800000000 },
  list: [{ url: 'http://first' }, { url: 'http://second' }],
  'weird-key': { value: 'ok' },
}

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

export default (t) => {
  t.suite('JSONPath：点号 / 下标 / 方括号 / 缺省', () => {
    t.eq(pick(PAYLOAD, '$.data.url').value, 'http://cdn/a.flac')
    t.eq(pick(PAYLOAD, 'data.url').value, 'http://cdn/a.flac', '省略 $ 也行')
    t.eq(pick(PAYLOAD, '$.list[1].url').value, 'http://second')
    t.eq(pick(PAYLOAD, "$['weird-key']['value']").value, 'ok', '带连字符的键用方括号')
    t.eq(pick(PAYLOAD, '$.data.missing').found, false)
    t.eq(pickString(PAYLOAD, '$.list[9].url'), null)
    t.eq(pickString(PAYLOAD, '$.code'), '0', '数字也能取成字符串')
  })

  t.suite('配置解析：JSON 字符串 / 单对象 / 缺字段报错', () => {
    const list = parseCustomSources('[{"baseUrl":"https://a.com/","source":"kw","request":{"path":"/x"},"response":{"url":"$.u"}}]')
    t.eq(list.length, 1)
    t.eq(list[0].baseUrl, 'https://a.com', '尾部斜杠被规范化')
    const single = parseCustomSources('{"baseUrl":"https://b.com","source":"kg","request":{"path":"/x"},"response":{"url":"$.u"}}')
    t.eq(single.length, 1, '单对象也接受')
    t.eq(parseCustomSources(''), [], '空串等于没配')
    t.eq(parseCustomSources(undefined), [], 'undefined 安全')
    t.ok((() => { try { parseCustomSources('{oops') } catch (e) { return e.code === 'bad_request' } return false })(), '非法 JSON → bad_request')
    t.ok((() => { try { parseCustomSources('[{"baseUrl":"https://c.com"}]') } catch (e) { return e.code === 'bad_request' } return false })(), '缺 request/response → bad_request')
  })

  t.suite('请求模板：POST + 参数名映射 + Header 鉴权 + $.data.url', async() => {
    let seen = null
    const { server, port } = await start(({ url, method, headers, body, send }) => {
      seen = { path: url.pathname, method, key: headers['x-api-key'], body }
      send(200, PAYLOAD)
    })
    const config = {
      name: 'demo', baseUrl: `http://127.0.0.1:${port}`, token: 'SECRET', source: 'kw',
      qualities: ['flac', '320k'],
      request: { method: 'POST', path: '/api/parse', body: { musicId: '{id}', src: '{source}', q: '{quality}' }, auth: { in: 'header', name: 'X-Api-Key' } },
      response: { url: '$.data.url', quality: '$.data.quality', expiresAt: '$.data.exp', error: '$.msg' },
    }
    const provider = new CustomApiProvider({ config: parseCustomSources([config])[0], fetchImpl: fetch })
    const result = await provider.resolveUrl({ source: 'kw', id: '42', quality: '320k' })
    t.eq(seen.path, '/api/parse')
    t.eq(seen.method, 'POST')
    t.eq(seen.key, 'SECRET', '密钥进 Header')
    t.eq(seen.body, { musicId: '42', src: 'kw', q: '320k' }, '占位符 + 参数名映射')
    t.eq(result.url, 'http://cdn/a.flac')
    t.eq(result.quality, 'flac', '实际音质按 $.data.quality')
    t.eq(result.expiresAt, '1800000000')
    server.close()
  })

  t.suite('鉴权可放 Query：?key=SECRET', async() => {
    let seenKey = null
    const { server, port } = await start(({ url, send }) => {
      seenKey = url.searchParams.get('api_key')
      send(200, { url: 'http://cdn/b.mp3' })
    })
    const provider = new CustomApiProvider({
      config: parseCustomSources([{ baseUrl: `http://127.0.0.1:${port}`, token: 'SECRET', source: 'kg', request: { path: '/u', query: { id: '{id}' }, auth: { in: 'query', name: 'api_key' } }, response: { url: '$.url' } }])[0],
      fetchImpl: fetch,
    })
    const result = await provider.resolveUrl({ source: 'kg', id: '7', quality: '320k' })
    t.eq(seenKey, 'SECRET', '密钥进查询参数')
    t.eq(result.url, 'http://cdn/b.mp3')
    server.close()
  })

  t.suite('成功判定 + 错误归一：code 不对就用 response.error 的文案定错误码', async() => {
    const { server, port } = await start(({ send }) => send(200, { code: 500, msg: '密钥验证失败' }))
    const provider = new CustomApiProvider({
      config: parseCustomSources([{ baseUrl: `http://127.0.0.1:${port}`, source: 'kw', request: { path: '/u' }, response: { url: '$.data.url', error: '$.msg', code: { path: '$.code', ok: 0 } } }])[0],
      fetchImpl: fetch,
    })
    await t.rejects(() => provider.resolveUrl({ source: 'kw', id: '1', quality: '320k' }), 'unauthorized', '密钥类文案 → unauthorized')
    server.close()
  })

  t.suite('提取不到直链：按 response.error 文案报错，而不是返回空 url', async() => {
    const { server, port } = await start(({ send }) => send(200, { code: 0, msg: '该歌曲无版权' }))
    const provider = new CustomApiProvider({
      config: parseCustomSources([{ baseUrl: `http://127.0.0.1:${port}`, source: 'kw', request: { path: '/u' }, response: { url: '$.data.url', error: '$.msg' } }])[0],
      fetchImpl: fetch,
    })
    await t.rejects(() => provider.resolveUrl({ source: 'kw', id: '1', quality: '320k' }), 'upstream_denied', '版权类文案 → upstream_denied')
    server.close()
  })

  t.suite('引擎注册：只填 地址+密钥+规则 就能当音源用，且优先于远端端点', async() => {
    const { server, port } = await start(({ send }) => send(200, { data: { url: 'http://cdn/custom.flac', quality: 'flac' } }))
    const engine = new SourceEngine()
    const result = await engine.init({
      endpoints: [{ baseUrl: 'http://127.0.0.1:1' }],
      customSources: parseCustomSources([{
        name: 'my-source', baseUrl: `http://127.0.0.1:${port}`, token: 'k', source: 'kw',
        qualities: ['flac', '320k'], request: { method: 'GET', path: '/get', query: { musicId: '{id}' }, auth: { in: 'query', name: 'key' } },
        response: { url: '$.data.url', quality: '$.data.quality' },
      }]),
    })
    t.eq(result.ok, true, '端点全挂也不影响：通用源能出直链')
    t.eq(result.qualityList.kw.includes('flac'), true, '源表里出现 flac')
    const played = await engine.apis('kw').getMusicUrl({ songmid: '42' }, 'flac').promise
    t.eq(played.url, 'http://cdn/custom.flac')
    server.close()
  })
}
