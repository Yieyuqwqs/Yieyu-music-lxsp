/**
 * 手写 WASM 音源插件生成器（不依赖任何编译器）
 *
 * 产物：plugins/api-mode.wasm —— 真正可执行的 WebAssembly 模块，实现 ABI v2：
 *   export memory
 *   export alloc(len:i32) -> ptr
 *   export resolve(srcPtr,srcLen,idPtr,idLen,qPtr,qLen) -> ptr   // 返回 NUL 结尾的直链，0 = 失败
 *   import env.http(urlPtr,urlLen,bodyPtr,bodyLen) -> ptr        // bodyLen=0 表示 GET
 *   import env.log(ptr,len)
 *
 * 逻辑：GET {BASE}/{source}/{id}?quality={q}，从响应 JSON 里取 "data":"..." 的值当直链。
 *
 * 用法：node tools/wasm/build-plugin.mjs [BASE_URL]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MODULE_BYTES_LIMIT = 64 * 1024

// ---------------- 二进制编码小工具 ----------------
const uleb = (value) => {
  const out = []
  let v = value >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v) byte |= 0x80
    out.push(byte)
  } while (v)
  return out
}
const sleb = (value) => {
  const out = []
  let v = value | 0
  while (true) {
    const byte = v & 0x7f
    const sign = byte & 0x40
    v >>= 7
    if ((v === 0 && !sign) || (v === -1 && sign)) {
      out.push(byte)
      break
    }
    out.push(byte | 0x80)
  }
  return out
}
const str = (text) => {
  const bytes = [...Buffer.from(text, 'utf8')]
  return [...uleb(bytes.length), ...bytes]
}
const vec = (items) => [...uleb(items.length), ...items.flat()]
const section = (id, payload) => [id, ...uleb(payload.length), ...payload]

// 指令
const I32 = 0x7f
const op = {
  unreachable: [0x00],
  end: [0x0b],
  return_: [0x0f],
  else_: [0x05],
  block: (bt = 0x40) => [0x02, bt],
  loop: (bt = 0x40) => [0x03, bt],
  if_: (bt = 0x40) => [0x04, bt],
  br: (depth) => [0x0c, ...uleb(depth)],
  brIf: (depth) => [0x0d, ...uleb(depth)],
  call: (index) => [0x10, ...uleb(index)],
  localGet: (i) => [0x20, ...uleb(i)],
  localSet: (i) => [0x21, ...uleb(i)],
  localTee: (i) => [0x22, ...uleb(i)],
  globalGet: (i) => [0x23, ...uleb(i)],
  globalSet: (i) => [0x24, ...uleb(i)],
  i32Const: (v) => [0x41, ...sleb(v)],
  load8: (offset = 0) => [0x2d, 0x00, ...uleb(offset)],
  store8: (offset = 0) => [0x3a, 0x00, ...uleb(offset)],
  // 无参指令
  i32Add: [0x6a],
  i32Sub: [0x6b],
  i32Mul: [0x6c],
  i32And: [0x71],
  i32Eq: [0x46],
  i32Ne: [0x47],
  i32LtS: [0x48],
  i32GtS: [0x4a],
  i32LeS: [0x4c],
  i32GeS: [0x4e],
  i32Eqz: [0x45],
}

// ---------------- 代码生成 ----------------
const build = (baseUrl) => {
  // 数据段布局：0x00 起放 BASE 字符串（NUL 结尾）
  const baseBytes = [...Buffer.from(baseUrl, 'utf8'), 0]
  const BASE_ADDR = 0
  const HEAP_START = 32768
  const SCRATCH = 4096

  // func 0: import env.http(i32,i32,i32,i32)->i32
  // func 1: import env.log(i32,i32)->void
  // func 2: alloc(len)->ptr
  // func 3: copy(dst,src,len)->dst+len
  // func 4: resolve(srcPtr,srcLen,idPtr,idLen,qPtr,qLen)->ptr

  const types = [
    [0x60, ...uleb(4), I32, I32, I32, I32, ...uleb(1), I32], // 0: http
    [0x60, ...uleb(2), I32, I32, ...uleb(0)],                // 1: log
    [0x60, ...uleb(1), I32, ...uleb(1), I32],                // 2: alloc
    [0x60, ...uleb(3), I32, I32, I32, ...uleb(1), I32],      // 3: copy
    [0x60, ...uleb(6), I32, I32, I32, I32, I32, I32, ...uleb(1), I32], // 4: resolve
  ]

  const imports = [
    [...str('env'), ...str('http'), 0x00, ...uleb(0)],
    [...str('env'), ...str('log'), 0x00, ...uleb(1)],
  ]

  const functions = [2, 3, 4] // alloc, copy, resolve（索引 2,3,4）

  // --- alloc(len) ---
  const allocBody = [
    ...op.localGet(0), ...op.i32Const(7), ...op.i32Add, ...op.i32Const(-8), ...op.i32And, ...op.localSet(1),
    ...op.globalGet(0), ...op.localSet(2),
    ...op.globalGet(0), ...op.localGet(1), ...op.i32Add, ...op.globalSet(0),
    ...op.localGet(2),
    ...op.end,
  ]

  // --- copy(dst,src,len) -> dst+len ; local i=3 ---
  const copyBody = [
    ...op.block(),
    ...op.loop(),
    ...op.localGet(3), ...op.localGet(2), ...op.i32GeS, ...op.brIf(1),
    ...op.localGet(0), ...op.localGet(3), ...op.i32Add,
    ...op.localGet(1), ...op.localGet(3), ...op.i32Add, ...op.load8(0),
    ...op.store8(0),
    ...op.localGet(3), ...op.i32Const(1), ...op.i32Add, ...op.localSet(3),
    ...op.br(0),
    ...op.end,
    ...op.end,
    ...op.localGet(0), ...op.localGet(2), ...op.i32Add,
    ...op.end,
  ]

  // --- resolve(...) ; locals: 6 buf,7 n,8 resp,9 p ---
  const NEEDLE = [0x22, 0x64, 0x61, 0x74, 0x61, 0x22, 0x3a, 0x22] // "data":"
  const QMARK = [...Buffer.from('?quality=', 'utf8'), 0]
  const SLASH = [0x2f, 0]

  const resolveBody = [
    // buf = alloc(512)
    ...op.i32Const(1024), ...op.call(2), ...op.localSet(6),
    // n = copy(buf, BASE, len(BASE))
    ...op.localGet(6), ...op.i32Const(BASE_ADDR), ...op.i32Const(baseBytes.length - 1), ...op.call(3), ...op.localSet(7),
    // n = copy(n, src, srcLen)
    ...op.localGet(7), ...op.localGet(0), ...op.localGet(1), ...op.call(3), ...op.localSet(7),
    // n = copy(n, SLASH, 1)
    ...op.localGet(7), ...op.i32Const(0x2000), ...op.i32Const(1), ...op.call(3), ...op.localSet(7),
    // n = copy(n, id, idLen)
    ...op.localGet(7), ...op.localGet(2), ...op.localGet(3), ...op.call(3), ...op.localSet(7),
    // n = copy(n, QMARK, len)
    ...op.localGet(7), ...op.i32Const(0x2100), ...op.i32Const(QMARK.length - 1), ...op.call(3), ...op.localSet(7),
    // n = copy(n, q, qLen)
    ...op.localGet(7), ...op.localGet(4), ...op.localGet(5), ...op.call(3), ...op.localSet(7),
    // store8(n, 0)
    ...op.localGet(7), ...op.i32Const(0), ...op.store8(0),
    // resp = http(buf, n-buf, 0, 0)
    ...op.localGet(6), ...op.localGet(7), ...op.localGet(6), ...op.i32Sub, ...op.i32Const(0), ...op.i32Const(0),
    ...op.call(0), ...op.localSet(8),
    // if !resp return 0
    ...op.localGet(8), ...op.i32Eqz, ...op.if_(), ...op.i32Const(0), ...op.return_, ...op.end,
    // p = resp
    ...op.localGet(8), ...op.localSet(9),
    // 扫描 needle
    ...op.block(),
    ...op.loop(),
    ...op.localGet(9), ...op.load8(0), ...op.i32Eqz, ...op.brIf(1),
    // cond = AND(load8(p+k) == NEEDLE[k])
    ...NEEDLE.map((byte, k) => [...op.localGet(9), ...op.load8(k), ...op.i32Const(byte), ...op.i32Eq]).flat(),
    ...op.i32And, ...op.i32And, ...op.i32And, ...op.i32And, ...op.i32And, ...op.i32And, ...op.i32And,
    ...op.if_(),
    // urlStart = p + 8；把收尾引号写成 NUL，直接返回它（不复制、不再分配）
    ...op.localGet(9), ...op.i32Const(NEEDLE.length), ...op.i32Add, ...op.localSet(10),
    ...op.localGet(10), ...op.localSet(11),
    ...op.block(),
    ...op.loop(),
    ...op.localGet(11), ...op.load8(0), ...op.i32Eqz, ...op.brIf(1),
    ...op.localGet(11), ...op.load8(0), ...op.i32Const(0x22), ...op.i32Eq,
    ...op.if_(),
    ...op.localGet(11), ...op.i32Const(0), ...op.store8(0),
    ...op.br(2),
    ...op.end,
    ...op.localGet(11), ...op.i32Const(1), ...op.i32Add, ...op.localSet(11),
    ...op.br(0),
    ...op.end,
    ...op.end,
    ...op.localGet(10), ...op.return_,
    ...op.end,
    // p++
    ...op.localGet(9), ...op.i32Const(1), ...op.i32Add, ...op.localSet(9),
    ...op.br(0),
    ...op.end,
    ...op.end,
    // 没找到
    ...op.i32Const(0),
    ...op.end,
  ]

  const code = (body, locals) => {
    const localDecls = locals.length ? [...uleb(locals.length), ...locals.flatMap(([count, type]) => [...uleb(count), type])] : [0x00]
    const full = [...localDecls, ...body]
    return [...uleb(full.length), ...full]
  }

  const bodies = [
    code(allocBody, [[2, I32]]),        // locals 1,2
    code(copyBody, [[1, I32]]),         // local 3
    code(resolveBody, [[6, I32]]),      // locals 6..9
  ]

  const memory = vec([[0x00, ...uleb(1)]]) // min 1 page
  const globals = vec([[I32, 0x01, ...op.i32Const(HEAP_START), 0x0b]])
  const exports_ = vec([
    [...str('memory'), 0x02, ...uleb(0)],
    [...str('alloc'), 0x00, ...uleb(2)],
    [...str('resolve'), 0x00, ...uleb(4)],
  ])
  const data = vec([[...uleb(0), ...op.i32Const(BASE_ADDR), ...op.end, ...uleb(baseBytes.length), ...baseBytes],
    [...uleb(0), ...op.i32Const(0x2000), ...op.end, ...uleb(SLASH.length), ...SLASH],
    [...uleb(0), ...op.i32Const(0x2100), ...op.end, ...uleb(QMARK.length), ...QMARK]])

  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vec(types)),
    ...section(2, vec(imports)),
    ...section(3, vec(functions.map(f => uleb(f)))),
    ...section(5, memory),
    ...section(6, globals),
    ...section(7, exports_),
    ...section(10, vec(bodies)),
    ...section(11, data),
  ]
  return Uint8Array.from(bytes)
}

const baseUrl = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '') + '/url/'
const outFile = new URL('../../plugins/api-mode.wasm', import.meta.url).pathname
mkdirSync(dirname(outFile), { recursive: true })
const bytes = build(baseUrl)
if (bytes.length > MODULE_BYTES_LIMIT) throw new Error('模块超过 64KB')
writeFileSync(outFile, bytes)

// 内置到 App：534 字节的 base64，离线也能跑，不依赖任何下载地址
const tsFile = new URL('../../src/core/source/wasm-builtin.ts', import.meta.url).pathname
const base64 = Buffer.from(bytes).toString('base64')
writeFileSync(tsFile, `/** 自动生成，勿手改：node tools/wasm/build-plugin.mjs */
export interface BuiltinPlugin {
  name: string
  base64: string
  baseUrl: string
  qualities: string[]
}

export const BUILTIN_PLUGINS: Record<string, BuiltinPlugin> = {
  'api-mode': {
    name: '标准 API 模式（内置）',
    base64: '${base64}',
    baseUrl: '${baseUrl}',
    qualities: ['128k', '320k', 'flac', 'flac24bit'],
  },
}
`)
console.log(`已生成 ${outFile}`)
console.log(`大小 ${bytes.length} 字节 · BASE=${baseUrl}`)
