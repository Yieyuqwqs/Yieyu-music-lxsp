/**
 * WASM 插件链路：假 wasm 字节 + 假原生桥（真机里是 wasm3），验证协议/错误映射/引擎注册
 *
 * human-exempt: 人类授权 2026-11-27。node 里没有 wasm3 原生运行时，只能用假桥验证 ABI 与错误映射；
 * 真机上跑真 .wasm 的用例在 wasm-real.test.mjs（有原生桥时才执行）。
 * 缺少的验证：wasm3 实例化真实 .wasm 的耗时与内存上限。
 */
import { WasmPluginProvider, bytesToBase64 } from '../../src/core/source/wasm-plugin.ts'
import { SourceEngine } from '../../src/core/source/engine.ts'

const WASM_MAGIC = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x11])

/** 假桥：load 记一次，resolve 直接回插件该回的 JSON */
const fakeBridge = (reply) => {
  const calls = { load: 0, resolve: [], free: 0 }
  return {
    calls,
    bridge: {
      load: async() => { calls.load += 1; return 7 },
      resolve: async(_handle, source, musicId, quality) => {
        calls.resolve.push({ source, id: musicId, quality })
        return reply({ source, id: musicId, quality })
      },
      free: async() => { calls.free += 1 },
    },
  }
}

const fetchWasm = async() => ({
  status: 200,
  arrayBuffer: async() => WASM_MAGIC.buffer.slice(0),
})

export default (t) => {
  t.suite('base64：纯 JS 实现能编出等价的串', () => {
    t.eq(bytesToBase64(new Uint8Array([0x00, 0x61, 0x73, 0x6d])), 'AGFzbQ==')
    t.eq(bytesToBase64(new Uint8Array([])), '')
    t.eq(bytesToBase64(new Uint8Array([255, 255, 255])), '////')
  })

  t.suite('插件取直链：入参协议正确，出参按真音质回填', async() => {
    const { bridge, calls } = fakeBridge(() => 'http://cdn/wasm.flac')
    const provider = await WasmPluginProvider.create({
      config: { name: 'demo', source: 'kw', url: 'https://x/plugin.wasm' },
      bridge, priority: 0, fetchImpl: fetchWasm,
    })
    t.ok(provider, '加载成功')
    t.eq(calls.load, 1, '只 load 一次')
    const result = await provider.resolveUrl({ source: 'kw', id: '42', quality: 'flac', name: '歌', singer: '人' })
    t.eq(calls.resolve[0], { source: 'kw', id: '42', quality: 'flac' })
    t.eq(result.url, 'http://cdn/wasm.flac')
    t.eq(result.quality, 'flac')
    t.eq(provider.supports('search'), false, '插件不假装有搜索')
  })

  t.suite('插件返回错误码：按统一错误码抛出（unauthorized 不被当成没版权）', async() => {
    const { bridge } = fakeBridge(() => '')
    const provider = await WasmPluginProvider.create({
      config: { source: 'kw', url: 'https://x/p.wasm' }, bridge, priority: 0, fetchImpl: fetchWasm,
    })
    await t.rejects(() => provider.resolveUrl({ source: 'kw', id: '1', quality: '320k' }), 'upstream_error', '空返回就是 upstream_error')
  })

  t.suite('不是 wasm 的文件直接拒绝（不把 HTML 错误页当插件）', async() => {
    await t.rejects(async() => WasmPluginProvider.create({
      config: { source: 'kw', url: 'https://x/bad.wasm' },
      bridge: fakeBridge(() => '{}').bridge,
      priority: 0,
      fetchImpl: async() => ({ status: 200, arrayBuffer: async() => new Uint8Array([0x3c, 0x21, 0x44, 0x4f]).buffer }),
    }), 'bad_response', 'HTML 冒充 wasm')
  })

  t.suite('引擎注册：插件优先级高于端点，失败不影响其它音源', async() => {
    const { bridge } = fakeBridge(() => 'http://cdn/from-plugin.mp3')
    const engine = new SourceEngine()
    const result = await engine.init({
      endpoints: [],
      fetchImpl: fetchWasm,
      wasmBridge: bridge,
      wasmPlugins: [
        { name: 'ok', source: 'kw', url: 'https://x/ok.wasm', qualities: ['320k', '128k'] },
        { name: 'bad', source: 'kg', url: 'https://x/bad.wasm' },
      ],
    })
    t.eq(result.ok, true, '插件作为唯一音源也能用')
    t.eq(result.qualityList.kw.includes('320k'), true)
    const played = await engine.apis('kw').getMusicUrl({ songmid: '42' }, '320k').promise
    t.eq(played.url, 'http://cdn/from-plugin.mp3')
  })
}
