/**
 * WASM 插件配置解析（纯逻辑，无 RN 依赖，node 下可直接测）
 *
 * 为什么单独一个文件：
 *   以前这段解析写在 core/apiSource.ts 的 initSourceEngine 里（那里 import 了 setting/store/nativeModules，
 *   无法在 node 下测），而它恰好有一个"只有 url 才算合法"的错误过滤，
 *   导致 README 推荐的内置写法 {"builtin":"api-mode"} 被静默丢弃（插件永远加载不出来）。
 *
 * 合法条件（与 wasm-plugin.ts 的 WasmPluginProvider.create 对齐）：
 *   - source 必须是字符串
 *   - url 与 builtin 至少要有一个（builtin 走随包内置的 .wasm）
 */
import type { WasmPluginConfig } from './wasm-plugin'

export interface ParsedWasmPlugins {
  plugins: WasmPluginConfig[]
  /** 解析失败的原因（给设置页/日志用；不抛异常，避免一个手滑的 JSON 让整个音源初始化挂掉） */
  error?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
)

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** 单个配置 → WasmPluginConfig；不合法返回 null（不是抛错） */
export const normalizeWasmPluginConfig = (raw: unknown): WasmPluginConfig | null => {
  if (!isRecord(raw)) return null
  const source = asString(raw.source)
  if (!source) return null
  const url = asString(raw.url)
  const builtin = asString(raw.builtin)
  // url 与 builtin 必须有其一：有 url 就下载，有 builtin 就用包里那份
  if (!url && !builtin) return null
  const qualities = Array.isArray(raw.qualities)
    ? raw.qualities.map(item => asString(item)).filter(Boolean)
    : undefined
  return {
    id: asString(raw.id) || undefined,
    name: asString(raw.name) || undefined,
    source: source as WasmPluginConfig['source'],
    url: url || undefined,
    builtin: builtin || undefined,
    qualities: qualities && qualities.length ? qualities : undefined,
  }
}

/** 设置里那一格 JSON → 插件列表（兼容单对象写法） */
export const parseWasmPlugins = (raw: string | null | undefined): ParsedWasmPlugins => {
  const text = (raw ?? '').trim()
  if (!text) return { plugins: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { plugins: [], error: `WASM 插件配置不是合法 JSON：${(error as Error).message}` }
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const plugins: WasmPluginConfig[] = []
  const rejected: string[] = []
  for (const item of list) {
    const config = normalizeWasmPluginConfig(item)
    if (config) plugins.push(config)
    else rejected.push(JSON.stringify(item)?.slice(0, 80) ?? String(item))
  }
  return rejected.length
    ? { plugins, error: `以下插件缺少 source 或 (url|builtin)，已忽略：${rejected.join(' / ')}` }
    : { plugins }
}
