/**
 * 存储层的内存缓存（有界）。
 *
 * 根因：plugins/storage.ts 里的 kvCache 原本是一个裸 Map —— 只有 set，没有上限也没有淘汰。
 * 用户歌单动辄几 MB（单条 JSON），播一段时间后这些字符串会全部常驻内存，
 * 在低端机上就是「越用越卡、后台被杀」。
 *
 * 这里做两件事：
 *   1. 计数上限（maxEntries）与体积上限（maxBytes）双约束，超了就按 LRU 淘汰；
 *   2. 读命中即「触摸」，保证热数据不被冷数据挤掉。
 *
 * 注意：这层只是缓存，淘汰永远不影响正确性 —— 未命中会回落到 C++ SQLite / AsyncStorage。
 * 体积按字符串长度估算（JSON 以 ASCII 为主，误差在可接受范围内，且只用于淘汰决策）。
 */

export interface KvCacheOptions {
  /** 最多缓存多少条，默认 128 */
  maxEntries?: number
  /** 最多缓存多少"字节"（按字符数估算），默认 24MB */
  maxBytes?: number
}

const DEFAULT_MAX_ENTRIES = 128
const DEFAULT_MAX_BYTES = 24 * 1024 * 1024

export class BoundedKvCache {
  private readonly store = new Map<string, string>()
  private readonly maxEntries: number
  private readonly maxBytes: number
  private bytes = 0

  constructor(options: KvCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES)
  }

  get(key: string): string | undefined {
    const value = this.store.get(key)
    if (value === undefined) return undefined
    // 触摸：删了再插，把它顶到最新位置
    this.store.delete(key)
    this.store.set(key, value)
    return value
  }

  set(key: string, value: string): void {
    const existing = this.store.get(key)
    if (existing !== undefined) {
      this.bytes -= existing.length
      this.store.delete(key)
    }
    this.store.set(key, value)
    this.bytes += value.length
    this.evict()
  }

  delete(key: string): boolean {
    const existing = this.store.get(key)
    if (existing === undefined) return false
    this.bytes -= existing.length
    return this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
    this.bytes = 0
  }

  /** 当前条数（测试与自检用） */
  get size(): number {
    return this.store.size
  }

  /** 当前占用（字符数近似，测试与自检用） */
  get byteSize(): number {
    return this.bytes
  }

  keys(): string[] {
    return [...this.store.keys()]
  }

  private evict(): void {
    while (this.store.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.store.keys().next()
      if (oldest.done) return
      const value = this.store.get(oldest.value)
      if (value !== undefined) this.bytes -= value.length
      this.store.delete(oldest.value)
    }
  }
}
