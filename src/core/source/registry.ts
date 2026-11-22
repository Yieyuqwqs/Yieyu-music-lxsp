/**
 * Provider 注册表：音源 → Provider 的有序列表。
 * 同一音源可以有多个 Provider（主端点 / 镜像 / 内置模块），
 * 排序规则：健康度 → 优先级。坏源进冷却，但永不彻底删除（最后一根稻草也是稻草）。
 */
import { LxspError } from './errors'
import type { ProviderMeta, SourceProvider } from './types'

interface HealthState {
  /** 冷却结束时间戳；0 表示健康 */
  coolDownUntil: number
  lastCode?: LX.Lxsp.ErrorCode
}

const DEFAULT_COOLDOWN_MS = 60_000
const LX_QUALITY_NAMES: readonly LX.Quality[] = ['128k', '320k', 'flac', 'flac24bit', '192k', 'ape', 'wav']

export class SourceRegistry {
  private readonly providers = new Map<string, SourceProvider>()
  private readonly health = new Map<string, HealthState>()
  private readonly now: () => number
  private readonly cooldownMs: number

  constructor(options: { now?: () => number, cooldownMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
  }

  add(provider: SourceProvider): void {
    this.providers.set(provider.meta.id, provider)
  }

  remove(providerId: string): void {
    this.providers.delete(providerId)
    this.health.delete(providerId)
  }

  clear(): void {
    this.providers.clear()
    this.health.clear()
  }

  get size(): number {
    return this.providers.size
  }

  all(): SourceProvider[] {
    return [...this.providers.values()]
  }

  /** 某音源可用的 Provider，健康者在前，其次按 priority 升序 */
  providersFor(source: LX.Source, capability?: LX.Lxsp.Capability): SourceProvider[] {
    const list = [...this.providers.values()].filter(provider => {
      if (provider.meta.source !== source) return false
      return capability ? provider.supports(capability) : true
    })
    return list.sort((a, b) => {
      const healthDiff = Number(this.isCoolingDown(a.meta.id)) - Number(this.isCoolingDown(b.meta.id))
      if (healthDiff !== 0) return healthDiff
      if (a.meta.priority !== b.meta.priority) return a.meta.priority - b.meta.priority
      return a.meta.id.localeCompare(b.meta.id)
    })
  }

  best(source: LX.Source, capability?: LX.Lxsp.Capability): SourceProvider | null {
    return this.providersFor(source, capability)[0] ?? null
  }

  has(source: LX.Source, capability?: LX.Lxsp.Capability): boolean {
    return this.providersFor(source, capability).length > 0
  }

  capabilitiesOf(source: LX.Source): LX.Lxsp.Capability[] {
    const caps = new Set<LX.Lxsp.Capability>()
    for (const provider of this.providers.values()) {
      if (provider.meta.source !== source) continue
      for (const cap of provider.meta.capabilities) caps.add(cap)
    }
    return [...caps]
  }

  /** 每音源取最优 Provider 的能力并集，用于全局质量表 */
  qualitiesOf(source: LX.Source): LX.Lxsp.Quality[] {
    const providers = this.providersFor(source)
    if (!providers.length) return []
    const set = new Set<LX.Lxsp.Quality>()
    for (const provider of providers) for (const quality of provider.meta.qualities) set.add(quality)
    return [...set]
  }

  /**
   * 兼容 global.lx.qualityList 的形状。
   * 注意：只统计「能出直链」的源 —— 这个表在 App 里的语义是「该音源能不能播」，
   * 内置兜底源只有搜索/歌词能力，不能算进来。
   */
  qualityList(): LX.QualityList {
    const sources = new Set<LX.Source>()
    for (const provider of this.providers.values()) {
      if (!provider.supports('url')) continue
      sources.add(provider.meta.source)
    }
    const list: LX.QualityList = {}
    for (const source of sources) {
      const qualities = this.qualitiesOf(source).filter((quality): quality is LX.Quality => LX_QUALITY_NAMES.includes(quality as LX.Quality))
      if (qualities.length) list[source] = qualities
    }
    return list
  }

  markUnhealthy(providerId: string, code?: LX.Lxsp.ErrorCode, coolDownMs?: number): void {
    this.health.set(providerId, {
      coolDownUntil: this.now() + (coolDownMs ?? this.cooldownMs),
      lastCode: code,
    })
  }

  markHealthy(providerId: string): void {
    this.health.delete(providerId)
  }

  isCoolingDown(providerId: string): boolean {
    const state = this.health.get(providerId)
    if (!state) return false
    if (state.coolDownUntil <= this.now()) {
      this.health.delete(providerId)
      return false
    }
    return true
  }

  snapshot(): ProviderMeta[] {
    return this.all().map(provider => provider.meta)
  }
}

/** 没有任何 Provider 能提供该音源时的统一错误 */
export const noProviderError = (source: LX.Source, capability?: LX.Lxsp.Capability): LxspError => (
  new LxspError('unsupported', `no provider for source "${source}"${capability ? ` (${capability})` : ''}`, { source })
)
