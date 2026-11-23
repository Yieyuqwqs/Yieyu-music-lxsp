/** 真 wasm 插件测试：直接加载 plugins/api-mode.wasm，用假宿主跑一遍 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WASM_PATH = fileURLToPath(new URL('../../plugins/api-mode.wasm', import.meta.url))

/** 用 JS 实现宿主导入（真机上是 wasm3 + OkHttp），执行插件的 resolve */
const runPlugin = (bytes, httpImpl) => {
  const state = {}
  const calls = []
  const imports = {
    env: {
      http: (urlPtr, urlLen, bodyPtr, bodyLen) => {
        const view = new Uint8Array(state.memory.buffer)
        const url = Buffer.from(view.subarray(urlPtr, urlPtr + urlLen)).toString('utf8')
        calls.push(url)
        const response = httpImpl(url, bodyLen ? Buffer.from(view.subarray(bodyPtr, bodyPtr + bodyLen)).toString('utf8') : '')
        if (response === null) return 0
        const buf = Buffer.from(response, 'utf8')
        const ptr = state.exports.alloc(buf.length + 1)
        const after = new Uint8Array(state.memory.buffer)
        after.set(buf, ptr)
        after[ptr + buf.length] = 0
        return ptr
      },
      log: () => {},
    },
  }
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), imports)
  state.memory = instance.exports.memory
  state.exports = instance.exports

  const write = (text) => {
    const buf = Buffer.from(text, 'utf8')
    const ptr = instance.exports.alloc(buf.length + 1)
    const view = new Uint8Array(instance.exports.memory.buffer)
    view.set(buf, ptr)
    view[ptr + buf.length] = 0
    return [ptr, buf.length]
  }

  return {
    calls,
    resolve(source, id, quality) {
      const [sp, sl] = write(source)
      const [ip, il] = write(id)
      const [qp, ql] = write(quality)
      const outPtr = instance.exports.resolve(sp, sl, ip, il, qp, ql)
      if (!outPtr) return ''
      const view = new Uint8Array(instance.exports.memory.buffer)
      let end = outPtr
      while (end < view.length && view[end] !== 0) end++
      return Buffer.from(view.subarray(outPtr, end)).toString('utf8')
    },
  }
}

export default (t) => {
  const bytes = readFileSync(WASM_PATH)

  t.suite('真 wasm：文件头合法、能被引擎校验', () => {
    t.eq([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d], 'wasm magic')
    t.ok(bytes.length > 200 && bytes.length < 65536, `体积合理（${bytes.length} 字节）`)
    new WebAssembly.Module(bytes) // 不抛就是合法模块
  })

  t.suite('真 wasm：拼出正确的后端 URL，并从 JSON 里抠出直链', () => {
    const plugin = runPlugin(bytes, (url) => JSON.stringify({ code: 0, data: 'http://cdn/xyz.flac' }))
    const url = plugin.resolve('kw', 'abc123', 'flac')
    t.eq(plugin.calls[0], 'http://127.0.0.1:8080/url/kw/abc123?quality=flac', 'URL 由插件自己拼')
    t.eq(url, 'http://cdn/xyz.flac', '取到 data 字段的值')
  })

  t.suite('真 wasm：后端报错（没有 data 字段）→ 返回空，不编造 URL', () => {
    const plugin = runPlugin(bytes, () => JSON.stringify({ code: 403, msg: '鉴权失败' }))
    t.eq(plugin.resolve('kw', '1', '320k'), '', '没有直链就是空串')
  })

  t.suite('真 wasm：http 直接失败（返回 0）也不崩', () => {
    const plugin = runPlugin(bytes, () => null)
    t.eq(plugin.resolve('kg', '2', '128k'), '')
  })

  t.suite('真 wasm：多次调用互不影响（堆指针推进正常）', () => {
    let n = 0
    const plugin = runPlugin(bytes, () => JSON.stringify({ code: 0, data: `http://cdn/${++n}.mp3` }))
    t.eq(plugin.resolve('wy', '1', '320k'), 'http://cdn/1.mp3')
    t.eq(plugin.resolve('wy', '2', '320k'), 'http://cdn/2.mp3')
    t.eq(plugin.resolve('wy', '3', '320k'), 'http://cdn/3.mp3')
  })
}
