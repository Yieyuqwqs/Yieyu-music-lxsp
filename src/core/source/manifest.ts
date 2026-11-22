/**
 * manifest 解析与校验：音源的能力边界在这里被「声明」，
 * 之后引擎只按声明调用，不再靠 try/catch 试探某个源会不会做某件事。
 */
import { CAPABILITIES, LXSP_MAJOR } from './protocol'
import { LxspError } from './errors'
import { sortQualitiesDesc } from './quality'

const VALID_SOURCES: readonly LX.Source[] = ['kw', 'kg', 'tx', 'wy', 'mg', 'local']
const LX_QUALITY_NAMES: readonly LX.Quality[] = ['128k', '320k', 'flac', 'flac24bit', '192k', 'ape', 'wav']

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const asString = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback
const asInt = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined

const fail = (message: string, raw?: unknown): never => {
  throw new LxspError('bad_response', `manifest: ${message}`, { raw })
}

/** 解析并归一 manifest；任何不合法都视为 bad_response（不猜、不兼容） */
export const parseManifest = (raw: unknown): LX.Lxsp.Manifest => {
  if (!isObject(raw)) return fail('not an object', raw)

  const version = asString(raw.lxsp)
  if (!version) return fail('missing lxsp version', raw)
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  if (!Number.isFinite(major) || major !== LXSP_MAJOR) return fail(`unsupported lxsp version ${version}`, raw)

  if (!isObject(raw.provider)) return fail('missing provider', raw)
  const provider = {
    id: asString(raw.provider.id).trim(),
    name: asString(raw.provider.name).trim(),
    version: asString(raw.provider.version).trim() || '0.0.0',
    homepage: asString(raw.provider.homepage) || undefined,
    license: asString(raw.provider.license) || undefined,
  }
  if (!provider.id) return fail('provider.id is required', raw.provider)
  if (!provider.name) return fail('provider.name is required', raw.provider)

  if (!Array.isArray(raw.sources) || !raw.sources.length) return fail('sources must be a non-empty array', raw)

  const globalCapabilities = normalizeCapabilities(raw.capabilities, CAPABILITIES)
  const seen = new Set<string>()
  const sources: LX.Lxsp.SourceDecl[] = []
  for (const item of raw.sources) {
    if (!isObject(item)) return fail('source must be an object', item)
    const key = asString(item.key) as LX.Source
    if (!VALID_SOURCES.includes(key)) return fail(`unknown source key "${asString(item.key)}"`, item)
    if (seen.has(key)) return fail(`duplicate source key "${key}"`, item)
    seen.add(key)

    const rawQualities = Array.isArray(item.qualities) ? item.qualities : []
    const qualities = sortQualitiesDesc(rawQualities)
    if (!qualities.length) return fail(`source "${key}" declares no usable quality`, item)

    const capabilities = Array.isArray(item.capabilities)
      ? normalizeCapabilities(item.capabilities, globalCapabilities.length ? globalCapabilities : CAPABILITIES)
      : globalCapabilities

    sources.push({
      key,
      name: asString(item.name).trim() || key.toUpperCase(),
      qualities,
      capabilities: capabilities.length ? capabilities : globalCapabilities,
      idFormat: item.idFormat === 'uint' ? 'uint' : 'string',
      note: asString(item.note) || undefined,
    })
  }
  if (!sources.length) return fail('no valid sources', raw)

  const manifest: LX.Lxsp.Manifest = {
    lxsp: version as LX.Lxsp.Version,
    provider,
    sources,
    capabilities: globalCapabilities.length ? globalCapabilities : undefined,
    endpoints: isObject(raw.endpoints) ? normalizeEndpoints(raw.endpoints) : undefined,
    features: isObject(raw.features)
      ? {
        streamProxy: raw.features.streamProxy === true,
        crossSource: raw.features.crossSource === true,
        multiSource: raw.features.multiSource === true,
      }
      : undefined,
    limits: isObject(raw.limits)
      ? {
        timeoutMs: asInt(raw.limits.timeoutMs),
        maxPageSize: asInt(raw.limits.maxPageSize),
        urlTtlS: asInt(raw.limits.urlTtlS),
      }
      : undefined,
    auth: isObject(raw.auth)
      ? {
        required: raw.auth.required === true,
        scheme: raw.auth.scheme === 'header' || raw.auth.scheme === 'query' ? raw.auth.scheme : 'bearer',
        header: asString(raw.auth.header) || undefined,
        query: asString(raw.auth.query) || undefined,
      }
      : undefined,
    meta: isObject(raw.meta) ? raw.meta : undefined,
  }
  return manifest
}

const normalizeCapabilities = (raw: unknown, allowed: readonly LX.Lxsp.Capability[]): LX.Lxsp.Capability[] => {
  if (!Array.isArray(raw)) return []
  const out: LX.Lxsp.Capability[] = []
  for (const item of raw) {
    const cap = asString(item) as LX.Lxsp.Capability
    if (CAPABILITIES.includes(cap) && allowed.includes(cap) && !out.includes(cap)) out.push(cap)
  }
  return out
}

const normalizeEndpoints = (raw: Record<string, unknown>): LX.Lxsp.Manifest['endpoints'] => {
  const out: Record<string, string> = {}
  for (const key of Object.keys(raw)) {
    const value = asString(raw[key])
    if (value) out[key] = value
  }
  return out as LX.Lxsp.Manifest['endpoints']
}

/** 取某音源声明；不存在返回 null（表示该 Provider 不提供这个音源） */
export const sourceDecl = (manifest: LX.Lxsp.Manifest, key: LX.Source): LX.Lxsp.SourceDecl | null => (
  manifest.sources.find(item => item.key === key) ?? null
)

/** 某音源声明的音质（已归一并降序） */
export const declaredQualities = (manifest: LX.Lxsp.Manifest, key: LX.Source): LX.Lxsp.Quality[] => sourceDecl(manifest, key)?.qualities ?? []

/** 某音源声明的能力 */
export const declaredCapabilities = (manifest: LX.Lxsp.Manifest, key: LX.Source): LX.Lxsp.Capability[] => {
  const decl = sourceDecl(manifest, key)
  if (!decl) return []
  return decl.capabilities ?? manifest.capabilities ?? []
}

/** manifest → global.lx.qualityList（兼容旧调用点，只保留 LX.Quality 词汇） */
export const toQualityList = (manifest: LX.Lxsp.Manifest): LX.QualityList => {
  const list: LX.QualityList = {}
  for (const decl of manifest.sources) {
    const qualities = decl.qualities.filter((quality): quality is LX.Quality => LX_QUALITY_NAMES.includes(quality as LX.Quality))
    if (qualities.length) list[decl.key] = qualities
  }
  return list
}
