/**
 * 把 src/*.ts 转成 Workers 能直接跑的 ES 模块（dist/*.js）。
 * 用 node 自带的类型剥离，不需要装任何构建工具。
 */
import { stripTypeScriptTypes } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const srcDir = join(root, 'src')
const outDir = join(root, 'dist')
mkdirSync(outDir, { recursive: true })

const files = readdirSync(srcDir).filter(name => name.endsWith('.ts'))
for (const name of files) {
  const code = readFileSync(join(srcDir, name), 'utf8')
  let js = stripTypeScriptTypes(code, { mode: 'strip' })
  // Workers 的模块导入必须带扩展名
  js = js.replace(/from\s+'(\.\/[^']+)'/g, (all, spec) => (spec.endsWith('.js') ? all : `from '${spec}.js'`))
  writeFileSync(join(outDir, name.replace(/\.ts$/, '.js')), js)
  console.log(`  ${name} → dist/${name.replace(/\.ts$/, '.js')} (${js.length}B)`)
}
console.log('转换完成，共', files.length, '个模块')
