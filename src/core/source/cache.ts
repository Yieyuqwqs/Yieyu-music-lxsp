/**
 * 缓存与并发收敛：TTL + LRU + singleflight。
 * 「同一个 (源, id, 音质) 被界面和播放器各请求一次」这类问题
 * 必须在引擎层收敛，而不是指望每个脚本自己防抖。
 */

interface Entry<V> {
  value: V
  expireAt: number
}

export class TtlCache<K, V> {
  private readonly store = new Map<K, Entry<V>>()
  private readonly max: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: { max?: number, ttlMs?: number, now?: () => number } = {}) {
    this.max = options.max ?? 300
    this.ttlMs = options.ttlMs ?? 60_000
    this.now = options.now ?? Date.now
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expireAt <= this.now()) {
      this.store.delete(key)
      return undefined
    }
    // 触摸刷新 LRU 顺序
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  set(key: K, value: V, ttlMs?: number): void {
    if (this.store.has(key)) this.store.delete(key)
    this.store.set(key, { value, expireAt: this.now() + (ttlMs ?? this.ttlMs) })
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next()
      if (oldest.done) break
      this.store.delete(oldest.value)
    }
  }

  delete(key: K): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  get size(): number {
    return this.store.size
  }
}

/**
 * singleflight：同 key 并发合并成一次，结果（含失败）广播给所有等待者。
 * 失败不进缓存，避免一次抖动被放大成长期不可用。
 */
export class Singleflight<K, V> {
  private readonly inflight = new Map<K, Promise<V>>()

  run(key: K, task: () => Promise<V>): Promise<V> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    const promise = task().finally(() => {
      // 只清理自己，避免旧请求删掉新请求的槽位
      if (this.inflight.get(key) === promise) this.inflight.delete(key)
    })
    this.inflight.set(key, promise)
    return promise
  }

  get size(): number {
    return this.inflight.size
  }

  clear(): void {
    this.inflight.clear()
  }
}
