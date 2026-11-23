/** 每个地址用自己的 API_KEY：主的 key 不会漏给备用，备用缺 key 时回落到主 key */
import http from 'node:http'
import { parseEndpoints, SourceEngine } from '../../src/core/source/engine.ts'

const start = (name, requiredKey, reply) => new Promise((resolve) => {
  const seen = { keys: [] }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const key = req.headers['x-api-key'] ?? url.searchParams.get('key') ?? ''
    seen.keys.push(String(key))
    if (requiredKey && String(key) !== requiredKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ code: 403, message: '密钥验证失败' }))
    }
    reply({ url, req, res, key })
  })
  server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port, name }))
})

const json = (res, payload) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }

export default (t) => {
  t.suite('配置解析：逐行 地址|密钥，备用不填则回落主密钥', () => {
    const list = parseEndpoints('http://a|KEY-A\nhttp://b\nhttp://c|KEY-C', 'KEY-MAIN')
    t.eq(list.map(item => [item.baseUrl, item.token]), [
      ['http://a', 'KEY-A'],
      ['http://b', 'KEY-MAIN'],
      ['http://c', 'KEY-C'],
    ])
  })

  t.suite('主地址密钥错、备用地址用自己的密钥 → 自动切到备用且各自带自己的 key', async() => {
    const primary = await start('primary', 'KEY-A', ({ res }) => json(res, { code: 200, url: 'http://cdn/primary.mp3' }))
    const backup = await start('backup', 'KEY-B', ({ url, res }) => {
      if (url.pathname === '/music/url') return json(res, { code: 200, url: 'http://cdn/backup.mp3' })
      return json(res, { code: 404, message: 'not found' })
    })

    const endpoints = parseEndpoints(
      `http://127.0.0.1:${primary.port}|KEY-A\nhttp://127.0.0.1:${backup.port}|KEY-B`,
      'KEY-A',
    )
    const engine = new SourceEngine()
    const result = await engine.init({ endpoints, token: 'KEY-A' })
    t.eq(result.ok, true, '两路都识别成功')
    t.eq(result.endpoints[0].ok, true)
    t.eq(result.endpoints[1].ok, true)

    // 主地址故意用错 key（KEY-A 服务端要求 KEY-A 才过，这里改成 KEY-WRONG 模拟“主的 key 失效”）
    const broken = parseEndpoints(
      `http://127.0.0.1:${primary.port}|KEY-WRONG\nhttp://127.0.0.1:${backup.port}|KEY-B`,
      'KEY-WRONG',
    )
    const engine2 = new SourceEngine()
    await engine2.init({ endpoints: broken, token: 'KEY-WRONG' })
    const played = await engine2.apis('kg').getMusicUrl({ songmid: '42' }, '320k').promise
    t.eq(played.url, 'http://cdn/backup.mp3', '主的 key 失效后由备用出链')
    t.ok(backup.seen.keys.includes('KEY-B'), '备用拿到的是它自己的 key：' + backup.seen.keys.join(','))

    primary.server.close()
    backup.server.close()
  })
}
