/**
 * WASM 音源插件 Provider。
 *
 * 插件是编译到 WebAssembly 的小模块，跑在 App 内嵌的 wasm3 解释器里（原生层），
 * 只能通过 `env.http` 发同步请求 —— 没有文件、进程、系统权限。
 *
 * 插件 ABI：
 *   export memory
 *   export alloc(size: i32) -> i32
 *   export resolve(ptr: i32, len: i32) -> i32   // 输入/输出都是 UTF-8 JSON
 *   import env.http(urlPtr, urlLen, bodyPtr, bodyLen) -> i32
 *   import env.log(ptr, len)
 *
 * 入参  {"action":"url","source":"kw","id":"42","quality":"flac","name":"…","singer":"…"}
 * 出参  {"url":"https://…","quality":"flac"} 或 {"error":"…","code":"unauthorized"}
 */
import { LxspError } from './errors'
import { normalizeQuality, sortQualitiesDesc } from './quality'
import type { FetchLike } from './transport'
import type { LyricResult, ProviderMeta, RequestContext, SearchResultData, SourceProvider, TrackQuery, UrlQuery, UrlResult } from './types'

export interface WasmBridge {
  load: (base64: string) => Promise<number>
  resolve: (handle: number, payload: string) => Promise<string>
  free: (handle: number) => Promise<void>
}

export interface WasmPluginConfig {
  id?: string
  name?: string
  source: LX.Source
  /** 插件 .wasm 的下载地址（初始化时拉取） */
  url: string
  qualities?: string[]
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 纯 JS base64：Hermes 没有 btoa，也不该为了这点事加依赖 */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out += BASE64_CHARS[b0 >> 2]
    out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? BASE64_CHARS[b2 & 63] : '='
  }
  return out
}

const parsePayload = (text: string): Record<string, unknown> | null => {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const value = JSON.parse(trimmed.slice(start, end + 1))
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch (error) {
    return null
  }
}

const mapCode = (code: unknown, message: string): LxspError => {
  const text = typeof code === 'string' ? code : ''
  if (text === 'unauthorized' || text === 'upstream_denied' || text === 'not_found' || text === 'quality_unavailable' ||
    text === 'timeout' || text === 'rate_limited' || text === 'unsupported' || text === 'network' || text === 'upstream_error') {
    return new LxspError(text, message || text)
  }
  if (/密钥|鉴权|unauthorized/i.test(message)) return new LxspError('unauthorized', message)
  if (/版权|VIP|付费/i.test(message)) return new LxspError('upstream_denied', message)
  if (/未找到|不存在/i.test(message)) return new LxspError('not_found', message)
  return new LxspError('upstream_error', message || '插件返回错误')
}

export class WasmPluginProvider implements SourceProvider {
  readonly meta: ProviderMeta
  private disposed = false
  private readonly handle: number
  private readonly bridge: WasmBridge

  private constructor(options: { config: WasmPluginConfig, handle: number, bridge: WasmBridge, priority: number }) {
    this.handle = options.handle
    this.bridge = options.bridge
    this.meta = {
      id: `wasm:${options.config.id ?? options.config.name ?? options.config.url}:${options.config.source}`,
      providerId: 'wasm-plugin',
      name: options.config.name ?? `WASM 插件（${options.config.url}）`,
      version: '1',
      kind: 'lxsp',
      endpoint: options.config.url,
      source: options.config.source,
      priority: options.priority,
      qualities: sortQualitiesDesc(options.config.qualities ?? ['128k', '320k', 'flac']),
      capabilities: ['url'],
    }
  }

  static async create(options: {
    config: WasmPluginConfig
    bridge: WasmBridge
    priority: number
    fetchImpl: FetchLike
    timeoutMs?: number
  }): Promise<WasmPluginProvider | null> {
    const timeoutMs = options.timeoutMs ?? 8000
    const response = await Promise.race([
      options.fetchImpl(options.config.url, { method: 'GET', headers: { Accept: 'application/wasm,*/*' } }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new LxspError('timeout', '插件下载超时')), timeoutMs)),
    ])
    const buffer = await readBytes(response)
    if (!buffer || buffer.length < 8) throw new LxspError('bad_response', '插件不是合法的 wasm（内容为空）')
    // wasm magic: 00 61 73 6d
    if (!(buffer[0] === 0x00 && buffer[1] === 0x61 && buffer[2] === 0x73 && buffer[3] === 0x6d)) {
      throw new LxspError('bad_response', '插件不是合法的 wasm（magic 不对）')
    }
    const handle = await options.bridge.load(bytesToBase64(buffer))
    if (!handle) throw new LxspError('bad_response', '插件加载失败')
    return new WasmPluginProvider({ config: options.config, handle, bridge: options.bridge, priority: options.priority })
  }

  supports(capability: LX.Lxsp.Capability): boolean {
    return this.meta.capabilities.includes(capability)
  }

  async resolveUrl(query: UrlQuery, ctx: RequestContext = {}): Promise<UrlResult> {
    if (this.disposed) throw new LxspError('canceled', '插件已卸载')
    const payload = JSON.stringify({
      action: 'url',
      source: query.source,
      id: query.id,
      quality: query.quality ?? '320k',
      name: query.name ?? '',
      singer: query.singer ?? '',
    })
    const text = await Promise.race([
      this.bridge.resolve(this.handle, payload),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new LxspError('timeout', '插件执行超时')), ctx.timeoutMs ?? 12000)),
    ])
    const data = parsePayload(String(text))
    if (!data) throw new LxspError('bad_response', '插件返回无法解析')
    const url = typeof data.url === 'string' ? data.url : ''
    if (!/^https?:\/\//i.test(url)) throw mapCode(data.code, String(data.error ?? data.message ?? '插件没有返回直链'))
    const requested = query.quality ?? 'auto'
    const actual = normalizeQuality(data.quality) ?? (query.quality ?? '128k')
    return {
      url,
      quality: actual,
      requestedQuality: requested,
      downgraded: requested !== 'auto' && sortQualitiesDesc([actual, requested])[0] === requested,
      detail: { format: /\.flac(\?|$)/i.test(url) ? 'flac' : (/\.mp3(\?|$)/i.test(url) ? 'mp3' : null) },
      via: { upstream: `wasm:${this.meta.name}`, cache: 'upstream', coalesced: false },
    }
  }

  async lyric(): Promise<LyricResult> {
    throw new LxspError('unsupported', '插件未声明歌词能力')
  }

  async pic(): Promise<string> {
    throw new LxspError('unsupported', '插件未声明封面能力')
  }

  async search(): Promise<SearchResultData> {
    throw new LxspError('unsupported', '插件未声明搜索能力')
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.bridge.free(this.handle).catch(() => {})
  }
}

/** 纯 JS UTF-8 编码：Hermes 没有 TextEncoder，不能直接用它 */
const utf8Encode = (text: string): Uint8Array => {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000
        i += 1
      }
    }
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return new Uint8Array(out)
}

const readBytes = async(response: { arrayBuffer?: () => Promise<ArrayBuffer>, text?: () => Promise<string>, status?: number }): Promise<Uint8Array | null> => {
  if (typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  }
  if (typeof response.text === 'function') {
    const text = await response.text()
    return utf8Encode(text)
  }
  return null
}

export { readBytes, utf8Encode }
