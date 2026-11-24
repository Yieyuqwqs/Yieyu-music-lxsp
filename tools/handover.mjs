#!/usr/bin/env node
/**
 * 交接报告生成器（把宪法第 8/12 条机械化的关键：报告只能由真实输出拼接）
 *  - 每段内容都来自本次真实执行的命令输出
 *  - 生成后自检：禁止出现甩锅句式（含"人工判定/需人工/你装上看/把日志发我/自行判断"）
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { return String(error.stdout ?? error.message) }
}

const sections = [
  ['分支审计', run(process.execPath, ['tools/if-audit.mjs'])],
  ['全量测试', run(process.execPath, ['--import', './tests/lxsp/hook.mjs', 'tests/lxsp/run.mjs'])],
  ['真实链路闭环', run(process.execPath, ['tools/device-sim.mjs'])],
]

const forbidden = ['人工判定', '需人工', '你装上看', '把日志发我', '自行判断', '麻烦你']
const status = JSON.parse(readFileSync(root + 'docs/status.json', 'utf8'))

const lines = []
lines.push('# 交接报告（自动生成）')
lines.push('')
lines.push(`生成时间：${new Date().toISOString()}`)
lines.push('')
lines.push('## 声明与来源')
lines.push('')
lines.push('| 声明 | 来源 | 证据命令 |')
lines.push('|---|---|---|')
for (const claim of status.claims) {
  lines.push(`| ${claim.claim} | ${claim.source} | ${claim.evidence.join(' ; ')} |`)
}
lines.push('')
for (const [name, output] of sections) {
  lines.push(`## ${name}`)
  lines.push('')
  lines.push('```')
  lines.push(output.trim().split('\n').slice(-14).join('\n'))
  lines.push('```')
  lines.push('')
}

const text = lines.join('\n')
const hits = forbidden.filter((word) => text.includes(word))
mkdirSync(root + 'docs/handover', { recursive: true })
writeFileSync(root + 'docs/handover/latest.md', text)

const jsonOnly = JSON.stringify(status)
const badClaims = status.claims.filter((c) => c.source === '实测' && (!c.evidence || c.evidence.length === 0))
if (hits.length) { console.error('交接报告含禁止句式：' + hits.join(', ')); process.exit(1) }
if (badClaims.length) { console.error('有「实测」声明缺少证据命令'); process.exit(1) }
if (jsonOnly.includes('人工判定')) { console.error('status.json 含禁止表述'); process.exit(1) }
console.log('交接报告已生成：docs/handover/latest.md')
console.log(`声明 ${status.claims.length} 条（实测 ${status.claims.filter((c) => c.source === '实测').length} / 未接上 ${status.claims.filter((c) => c.source === '未接上').length}）`)
console.log('禁止句式扫描：0 命中')
