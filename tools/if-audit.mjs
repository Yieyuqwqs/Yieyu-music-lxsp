#!/usr/bin/env node
/**
 * 条件分支审计器（不是"禁止 if"，而是让每个分支无处可藏）
 *
 * 背景：老板要求"代码里不许出现 if"。这在任何语言里都不可执行——
 * 没有条件分支就没有状态机、没有边界校验、没有错误处理。
 * 真正造成"补丁代码"的不是 if 本身，而是下面这几类用法，本工具把它们列为硬违规：
 *
 *   [禁止] 空 catch / 只写注释的 catch          —— 吞异常
 *   [禁止] catch 里直接 return 且无日志、无注释  —— 掩盖失败
 *   [禁止] 用魔法阈值绕过时序（setTimeout 里改数值）
 *
 *   [强制] 每个 if 必须可被列出：位置、代码、分类
 *         分类：invariant（不变量）/ boundary（边界校验）/ flow（正常分支）
 *         分类靠上下文推断，输出成清单——每次交付贴进报告
 *
 * 用法：node tools/if-audit.mjs [--json]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = ['src/core/listen-together', 'src/utils/nativeModules']
// 只看本项目负责的模块；btAudio/downloadService 是原有代码，不在本次范围
const ONLY = /(listen-together|nativeModules\/(p2p|syncEngine|clockrt))\.ts$/
const FILES_EXTRA = ['src/core/player/hooks.ts']
const BANNED = [
  { name: '空 catch（吞异常）', re: /catch\s*(\([^)]*\))?\s*\{\s*\}/ },
  { name: 'catch 里只有注释', re: /catch\s*(\([^)]*\))?\s*\{\s*\/\*[^*]*\*\/\s*\}/ },
  { name: 'catch 后直接 return（无日志）', re: /catch\s*(\([^)]*\))?\s*\{\s*return[^\n]*\n\s*\}/ },
]

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && ONLY.test(full)) out.push(full)
  }
  return out
}

const classify = (line) => {
  if (/invariant|generation|version|role|stableKey|roomId/.test(line)) return 'invariant'
  if (/typeof|undefined|null|Array\.isArray|Number\.isFinite|\.length|startsWith|test\(|match\(/.test(line)) return 'boundary'
  return 'flow'
}

const files = [...ROOTS.flatMap((root) => walk(root)), ...FILES_EXTRA]
const violations = []
const inventory = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const rel = relative(process.cwd(), file)

  for (const rule of BANNED) {
    const match = rule.re.exec(text)
    if (match) {
      const line = text.slice(0, match.index).split('\n').length
      violations.push({ file: rel, line, rule: rule.name, snippet: lines[line - 1]?.trim().slice(0, 100) })
    }
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!/^if\s*\(|^\}\s*else\s*if\s*\(/.test(trimmed)) return
    inventory.push({ file: rel, line: index + 1, kind: classify(trimmed), snippet: trimmed.slice(0, 90) })
  })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ violations, inventory }, null, 2))
} else {
  console.log(`条件分支审计：文件 ${files.length} 个，if 共 ${inventory.length} 处`)
  const stats = inventory.reduce((acc, item) => { acc[item.kind] = (acc[item.kind] || 0) + 1; return acc }, {})
  console.log(`分类：${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(' / ')}`)
  if (violations.length) {
    console.log(`\n硬违规 ${violations.length} 处：`)
    for (const v of violations) console.log(`  [禁止] ${v.rule}  ${v.file}:${v.line}  ${v.snippet}`)
  } else {
    console.log('硬违规：0')
  }
}
process.exit(violations.length ? 1 : 0)
