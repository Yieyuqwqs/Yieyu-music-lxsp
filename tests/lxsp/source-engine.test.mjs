/**
 * 音源引擎：配置解析 / 端点归属 / 探测延迟
 *
 * 这里不碰网络：所有 fetch 都是本文件里的可控实现，但**断言的是真实行为**——
 * 每个端点必须对自己的 provider 负责，探测必须在"有人成功"时就结束，
 * 而不是等所有候选都超时（后者用户能直接感觉到：保存并重连要等十几秒）。
 */
import { SourceEngine } from '../../src/core/source/engine.ts'
import { parseWasmPlugins } from '../../src/core/source/wasm-plugin-config.ts'
import { detectEndpoint } from '../../src/core/source/detect.ts'

const manifest = {
  lxsp: '2.0',
  provider: { id: 'pv', name: 'ProviderV', version: '1.0.0' },
  sources: [{ key: 'kw', name: 'KW', qualities: ['320k', 'flac'], capabilities: ['url', 'search'] }],
}

const jsonResponse = (body, status = 200) => ({
  status,
  ok: status < 400,
  headers: { get: () => null },
  text: async() => JSON.stringify(body),
})

const notFound = { status: 404, ok: false, headers: { get: () => null }, text: async() => 'nope' }

export default (t) => {
  t.suite('WASM 插件配置：README 里的 builtin 写法必须被接受（不能被静默丢弃）', () => {
    const builtin = parseWasmPlugins('[{"name":"本机网关","source":"kw","builtin":"api-mode"}]')
    t.eq(builtin.plugins.length, 1, 'builtin 写法必须解析出 1 个插件')
    t.eq(builtin.plugins[0].builtin, 'api-mode', 'builtin 字段要原样保留')
    t.eq(builtin.error, undefined, '合法配置不该产生错误信息')

    const urlStyle = parseWasmPlugins('[{"name":"别人的源","source":"kg","url":"https://example.com/p.wasm"}]')
    t.eq(urlStyle.plugins.length, 1, 'url 写法同样必须被接受')

    const single = parseWasmPlugins('{"source":"wy","builtin":"api-mode"}')
    t.eq(single.plugins.length, 1, '单对象写法（非数组）也要兼容')

    const rejected = parseWasmPlugins('[{"source":"kw","name":"既没 url 也没 builtin"}]')
    t.eq(rejected.plugins.length, 0, '缺 url/builtin 的配置不该进列表')
    t.ok(!!rejected.error && rejected.error.includes('url'), '被忽略时必须给出原因（不许静默）')

    const broken = parseWasmPlugins('{not json')
    t.eq(broken.plugins.length, 0, '非法 JSON 不能抛异常')
    t.ok(!!broken.error && broken.error.includes('JSON'), '非法 JSON 必须带原因')

    t.eq(parseWasmPlugins('').plugins.length, 0, '空配置返回空列表')
  })

  t.suite('端点健康探测：每个端点只对自己的 provider 负责（不许张冠李戴）', async() => {
    const hits = []
    const fetchImpl = async(url) => {
      hits.push(url)
      if (url.endsWith('/manifest')) return jsonResponse({ ok: true, data: manifest })
      if (url.endsWith('/healthz')) {
        // 10.0.0.1 健康，10.0.0.2 挂了 —— 两个端点必须报出不同结果
        return url.includes('10.0.0.1')
          ? jsonResponse({ ok: true, data: { status: 'ok' } })
          : jsonResponse({ ok: true, data: { status: 'down' } })
      }
      return notFound
    }

    const engine = new SourceEngine()
    await engine.init({
      endpoints: [{ baseUrl: 'http://10.0.0.1:8080' }, { baseUrl: 'http://10.0.0.2:8080' }],
      fetchImpl,
      timeoutMs: 500,
    })

    const probed = await engine.probe()
    t.eq(probed.length, 2, '两个端点都要探测')
    const a = probed.find(item => item.baseUrl === 'http://10.0.0.1:8080')
    const b = probed.find(item => item.baseUrl === 'http://10.0.0.2:8080')
    t.eq(a?.health, 'ok', '10.0.0.1 必须报 ok')
    t.eq(b?.health, 'down', '10.0.0.2 必须报 down（以前两个都报 ok，因为借用了同一个 provider）')
    t.ok(hits.some(url => url.startsWith('http://10.0.0.2:8080/healthz')), '健康探测必须打到 10.0.0.2 自己的地址上')
  })

  t.suite('端点探测：LXSP 秒回时必须立刻返回（不许等挂死的旧接口族）', async() => {
    const fetchImpl = (url) => url.endsWith('/manifest')
      ? Promise.resolve(jsonResponse({ ok: true, data: manifest }))
      : new Promise(() => {}) // 其余路径永不返回
    const startedAt = Date.now()
    const result = await detectEndpoint({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl,
      manifestTimeoutMs: 2000,
      profileTimeoutMs: 3000,
    })
    const elapsed = Date.now() - startedAt
    t.eq(result.detection?.kind, 'lxsp', '必须认出 LXSP')
    t.ok(elapsed < 800, `探测耗时必须接近 manifest 的即时返回，实际 ${elapsed}ms（旧实现要等 4×3000ms）`)
  })

  t.suite('端点初始化：多端点必须并行（不许一个端点拖垮整次重连）', async() => {
    const manifestLocal = {
      lxsp: '2.0',
      provider: { id: 'pv', name: 'ProviderV', version: '1.0.0' },
      sources: [{ key: 'kw', name: 'KW', qualities: ['320k'], capabilities: ['url'] }],
    }
    const slowFetch = (url) => url.endsWith('/manifest')
      ? new Promise((resolve) => setTimeout(() => resolve(jsonResponse({ ok: true, data: manifestLocal })), 300))
      : Promise.resolve(notFound)

    const measure = async(n) => {
      const engine = new SourceEngine()
      const startedAt = Date.now()
      const result = await engine.init({
        endpoints: Array.from({ length: n }, (_, i) => ({ baseUrl: `http://10.0.1.${i + 1}:8080` })),
        fetchImpl: slowFetch,
        timeoutMs: 1000,
      })
      return { elapsedMs: Date.now() - startedAt, ok: result.ok, providers: result.providerCount }
    }

    const one = await measure(1)
    const three = await measure(3)
    t.eq(one.providers, 1, '单端点必须装配出 1 个 provider')
    t.eq(three.providers, 3, '三端点必须装配出 3 个 provider')
    // 串行实现是 3 × 300ms ≈ 900ms；并行应接近单次 300ms
    t.ok(three.elapsedMs < one.elapsedMs * 1.8, `三端点耗时 ${three.elapsedMs}ms 必须接近单端点 ${one.elapsedMs}ms（串行会到 3 倍）`)
  })

  t.suite('取消：canceleFn 必须真的掐断解析（切歌后旧请求不能继续跑）', async() => {
    const fetchImpl = (url, init) => {
      if (url.endsWith('/manifest')) return Promise.resolve(jsonResponse({ ok: true, data: manifest }))
      return new Promise((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (init?.signal?.aborted) { abort(); return }
        init?.signal?.addEventListener?.('abort', abort)
      })
    }
    const engine = new SourceEngine()
    await engine.init({ endpoints: [{ baseUrl: 'http://10.0.2.1:8080' }], fetchImpl, timeoutMs: 500 })

    const request = engine.apis('kw').getMusicUrl({ id: '42', name: 'n', singer: 's' }, '320k')
    setTimeout(() => request.canceleFn(), 30)
    const error = await t.rejects(() => request.promise, 'canceled', '取消后必须抛 canceled')
    t.eq(error.code, 'canceled', '错误码必须是 canceled（而不是 network/internal）')
  })

  t.suite('直链缓存：命中时必须报真实来源（不能永远报主源）', async() => {
    const fetchImpl = (url) => {
      if (url.endsWith('/manifest')) return jsonResponse({ ok: true, data: manifest })
      if (url.includes('10.0.3.1') && url.includes('/url/')) return jsonResponse({ ok: false, error: { code: 'not_found', message: 'nope' } })
      if (url.includes('10.0.3.2') && url.includes('/url/')) {
        return jsonResponse({ ok: true, data: { url: 'http://cdn.test/a.mp3', quality: '320k' } })
      }
      return notFound
    }
    const engine = new SourceEngine()
    await engine.init({
      endpoints: [{ baseUrl: 'http://10.0.3.1:8080' }, { baseUrl: 'http://10.0.3.2:8080' }],
      fetchImpl,
      timeoutMs: 500,
    })

    const first = await engine.apis('kw').getMusicUrl({ id: '7', name: 'n', singer: 's' }, '320k').promise
    const second = await engine.apis('kw').getMusicUrl({ id: '7', name: 'n', singer: 's' }, '320k').promise
    t.ok(String(first.provider).includes('10.0.3.2'), `第一次必须报 10.0.3.2 这个源，实际 ${first.provider}`)
    t.eq(second.provider, first.provider, '缓存命中必须报同一个真实来源（旧实现会报 providers[0] = 10.0.3.1）')
    t.eq(second.url, first.url, '缓存命中返回值必须一致')
  })

  t.suite('直链缓存：服务端说已过期就不能进缓存', async() => {
    let calls = 0
    const fetchImpl = (url) => {
      if (url.endsWith('/manifest')) return jsonResponse({ ok: true, data: manifest })
      if (url.includes('/url/')) {
        calls += 1
        return jsonResponse({
          ok: true,
          data: { url: `http://cdn.test/expired-${calls}.mp3`, quality: '320k', expiresAt: new Date(Date.now() - 60_000).toISOString() },
        })
      }
      return notFound
    }
    const engine = new SourceEngine()
    await engine.init({ endpoints: [{ baseUrl: 'http://10.0.4.1:8080' }], fetchImpl, timeoutMs: 500 })

    await engine.apis('kw').getMusicUrl({ id: '9', name: 'n', singer: 's' }, '320k').promise
    await engine.apis('kw').getMusicUrl({ id: '9', name: 'n', singer: 's' }, '320k').promise
    t.eq(calls, 2, '已过期的直链不许进缓存，第二次必须重新请求')
  })

  t.suite('端点配置解析：去重（同一端点写两遍不能变成两个 Provider）', async() => {
    const { parseEndpoints } = await import('../../src/core/source/engine.ts')
    const list = parseEndpoints('http://a:8080, http://a:8080/, http://b:8080|tok, http://a:8080\nhttp://b:8080|tok')
    t.eq(list.length, 2, `重复项必须被去掉，实际 ${list.length} 条`)
    t.eq(list[0].baseUrl, 'http://a:8080', '顺序保留第一次出现的')
    t.eq(list[1].baseUrl, 'http://b:8080', '带 token 的端点排在第二')
    t.eq(list[1].token, 'tok', 'token 必须保留')
    // 不同 token = 不同端点，不许被合并
    const twoTokens = parseEndpoints('http://a:8080|k1, http://a:8080|k2')
    t.eq(twoTokens.length, 2, '同一地址不同密钥是两个端点')
    // 非法项仍然被丢弃
    t.eq(parseEndpoints('ftp://x, ,not-a-url').length, 0, '非 http(s) 一律丢弃')
    t.eq(parseEndpoints(null).length, 0, '空配置返回空数组')
  })
}
