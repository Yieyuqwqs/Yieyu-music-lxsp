/**
 * 测试加载器：让 node 能直接跑 App 里的 TypeScript 源码，且不依赖特定 Node 版本。
 *
 * 三件事（按顺序）：
 *   1. 解析：相对导入补 .ts/.tsx/.js 与 /index.*；@/ 别名映射到 src/；react-native 换成桩
 *   2. 转译：Node ≥22.6 用内置 stripTypeScriptTypes；否则用项目里的 @babel/core + typescript 插件
 *   3. 兜底：两者都没有 → 抛出明确错误（告诉使用者需要什么），绝不静默返回原代码
 *
 * 注意：这里不做任何"正则改写 TypeScript"的事——类型剥离必须交给真正的解析器。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CANDIDATES = ['.ts', '.tsx', '.js', '/index.ts', '/index.js']

// ---------- 1. 解析 ----------
export async function resolve(specifier, context, next) {
  if (specifier === 'react-native' || specifier.startsWith('react-native/')) {
    return next(new URL('./stubs/react-native.mjs', import.meta.url).href, context)
  }
  if (specifier.startsWith('@/')) {
    const root = new URL('../../src/', import.meta.url)
    for (const ext of CANDIDATES) {
      const candidate = new URL(specifier.slice(2) + ext, root)
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context)
    }
  }
  if (specifier.startsWith('.') && !/\.(m?[jt]sx?|json)$/.test(specifier)) {
    const base = new URL(specifier, context.parentURL)
    for (const ext of CANDIDATES) {
      const candidate = new URL(base.href + ext)
      if (existsSync(fileURLToPath(candidate))) return next(base.href + ext, context)
    }
  }
  return next(specifier, context)
}

// ---------- 2. 转译 ----------
let babelTransform = null
let babelTried = false

const loadBabel = async () => {
  if (babelTried) return babelTransform
  babelTried = true
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(process.cwd() + '/package.json')
    const core = req('@babel/core')
    const tsPlugin = req('@babel/plugin-transform-typescript')
    babelTransform = (code, filename) => core.transformSync(code, {
      filename,
      babelrc: false,
      configFile: false,
      plugins: [[tsPlugin, { isTSX: filename.endsWith('.tsx'), allExtensions: true }]],
    }).code
  } catch (error) {
    babelTransform = null
  }
  return babelTransform
}

export async function load(url, context, next) {
  if (!/\.(ts|tsx)$/.test(url)) return next(url, context)
  const filename = fileURLToPath(url)
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(filename, 'utf8')

  // 2a. Node 内置剥离（≥22.6，最稳）
  const { stripTypeScriptTypes } = await import('node:module')
  if (typeof stripTypeScriptTypes === 'function' && !filename.endsWith('.tsx')) {
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'strip' }), shortCircuit: true }
  }

  // 2b. Babel（Node 18/20，或 .tsx）
  const transform = await loadBabel()
  if (transform) {
    return { format: 'module', source: transform(source, filename), shortCircuit: true }
  }

  // 2c. 都不行：明确报错，不猜
  throw new Error(
    `[resolve-ts] 无法转译 ${filename}：当前 Node ${process.versions.node} 没有 stripTypeScriptTypes，` +
    '且项目里找不到 @babel/core + @babel/plugin-transform-typescript。请先安装依赖，或使用 Node ≥22.6。',
  )
}
