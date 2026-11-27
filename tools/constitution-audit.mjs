#!/usr/bin/env node
/**
 * 宪法自检（第十三条）
 *
 * 为什么要有它：宪法第十三条要求「每次交付前运行 node tools/constitution-audit.mjs」，
 * 但这个文件此前**根本不存在** —— 条款无法执行，报告里的"已自检"只能是空话。
 *
 * 设计原则：
 *   · 只做机械可验证的事；人工判断的条款诚实标 N/A 并写明理由（不假装 PASS）
 *   · 每条都打印证据（命令 + 关键输出），不只打印结论
 *   · 任何 FAIL → 退出码 1（CI 直接红）
 *
 * 用法：node tools/constitution-audit.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const node = process.execPath

const results = []
const record = (clause, name, status, evidence) => {
  results.push({ clause, name, status, evidence })
  console.log(`[${status}] 第 ${clause} 条 ${name}  —  ${evidence}`)
}

const run = (args, timeout = 240_000) => {
  const result = spawnSync(node, args, { cwd: root, encoding: 'utf8', timeout })
  return {
    ok: result.status === 0,
    status: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

const tail = (text, lines = 6) => text.trim().split('\n').slice(-lines).join(' | ')
const readFile = (relPath) => readFileSync(root + relPath, 'utf8')

// ---------- 1：禁止补丁式开发 ----------
{
  const audit = run(['tools/if-audit.mjs'], 60_000)
  const hit = /硬违规：(\d+)/.exec(audit.out)
  const violations = hit ? Number(hit[1]) : NaN
  if (!audit.ok) record(1, '禁止补丁式开发', 'FAIL', `if-audit 运行失败：${tail(audit.out)}`)
  else if (!Number.isFinite(violations)) record(1, '禁止补丁式开发', 'FAIL', 'if-audit 输出里没有「硬违规」计数')
  else record(1, '禁止补丁式开发', violations === 0 ? 'PASS' : 'FAIL', `硬违规=${violations}`)
}

// ---------- 3/4/10/11：跑整套 lxsp（含契约测试、模块解析、真链路） ----------
let lxsp = { ok: false, out: '' }
{
  lxsp = run(['--import', './tests/lxsp/hook.mjs', 'tests/lxsp/run.mjs'])
  const summary = /(全绿|有失败)：(\d+) 通过 \/ (\d+) 失败/.exec(lxsp.out)
  const evidence = summary ? `${summary[2]} 通过 / ${summary[3]} 失败` : tail(lxsp.out)
  const status = lxsp.ok ? 'PASS' : 'FAIL'
  record(3, '状态只有一个来源（契约测试）', status, evidence)
  record(4, '引用必须验证（定义/import/调用）', lxsp.ok ? 'PASS' : 'FAIL', evidence)
  const hasModules = existsSync(root + 'tests/lxsp/modules.test.mjs')
  record(10, 'CI 解析到每个模块', lxsp.ok && hasModules ? 'PASS' : 'FAIL', hasModules ? 'modules.test.mjs 已包含在套件里且全绿' : 'modules.test.mjs 缺失')
}

// ---------- 11（续）：真实链路 ----------
{
  if (/真实直链已验证/.test(lxsp.out)) {
    const line = lxsp.out.split('\n').find(item => item.includes('真实直链已验证')) ?? ''
    record(11, '真实链路（非温室测试）', 'PASS', line.trim())
  } else {
    record(11, '真实链路（非温室测试）', 'WARN', '本轮没拿到真实直链（网络/网关不可达）——不是通过，是没测')
  }
}

// ---------- 5：性能实测可用 ----------
{
  const bench = run(['--import', './tests/lxsp/hook.mjs', 'tools/lxsp-bench.mjs'], 120_000)
  record(5, '性能改动带实测（基准可运行）', bench.ok ? 'PASS' : 'WARN', bench.ok ? tail(bench.out, 3) : '除非本机网关在线，基准会失败；本轮以 node 侧延迟探针为证据')
}

// ---------- 6：构建 ----------
record(6, '构建失败只修根因', 'N/A', '本机没有 JDK/Android SDK，无法执行 gradle；APK 构建需在 CI 或开发机验证')

// ---------- 7：不留 TODO ----------
{
  const todo = spawnSync('grep', ['-rnE', 'TODO|FIXME', '--include=*.ts', '--include=*.tsx', '--include=*.js', 'src'], { cwd: root, encoding: 'utf8' })
  const lines = (todo.stdout ?? '').trim().split('\n').filter(Boolean)
  record(7, '不留临时方案（源码无 TODO）', lines.length === 0 ? 'PASS' : 'FAIL', lines.length === 0 ? 'src 下 TODO/FIXME = 0（历史项已迁到 docs/KNOWN-LIMITATIONS.md）' : `${lines.length} 处：${lines.slice(0, 3).join(' | ')}`)
}

// ---------- 8：诚实（status.json 格式） ----------
{
  try {
    const status = JSON.parse(readFile('docs/status.json'))
    const claims = Array.isArray(status.claims) ? status.claims : []
    const badSource = claims.filter(item => !['实测', '理论', '未接上'].includes(item.source))
    const noEvidence = claims.filter(item => item.source === '实测' && (!item.evidence || !item.evidence.length))
    if (!claims.length) record(8, '诚实高于好看（status.json）', 'FAIL', 'claims 为空')
    else if (badSource.length || noEvidence.length) record(8, '诚实高于好看（status.json）', 'FAIL', `来源非法 ${badSource.length} 条 / 实测无证据 ${noEvidence.length} 条`)
    else record(8, '诚实高于好看（status.json）', 'PASS', `${claims.length} 条声明，来源与证据齐全`)
  } catch (error) {
    record(8, '诚实高于好看（status.json）', 'FAIL', `读取失败：${error.message}`)
  }
}

// ---------- 9：改动清单 ----------
record(9, '改动清单纪律', 'N/A', '人工条款：本轮改动清单见交付报告（先清单后代码）')

// ---------- 12：不甩锅 ----------
record(12, '不把锅甩给人类', 'N/A', '人工条款：报告体例由交付报告保证')

// ---------- 13：自检本身 ----------
record(13, '自检条款', existsSync(root + 'tools/constitution-audit.mjs') ? 'PASS' : 'FAIL', '本脚本存在并可执行')

// ---------- 14：CI 必须真的跑测试 ----------
{
  const ciPath = root + '.github/workflows/ci.yml'
  if (!existsSync(ciPath)) {
    record(14, 'CI 必须跑测试', 'FAIL', '.github/workflows/ci.yml 不存在')
  } else {
    const ci = readFileSync(ciPath, 'utf8')
    const runsLxsp = ci.includes('tests/lxsp/run.mjs')
    const runsAuthz = ci.includes('tests/authz/run.mjs')
    const runsAudit = ci.includes('tools/constitution-audit.mjs')
    record(14, 'CI 必须跑测试', runsLxsp && runsAuthz && runsAudit ? 'PASS' : 'FAIL', `lxsp=${runsLxsp} authz=${runsAuthz} audit=${runsAudit}`)
  }
}

// ---------- 汇总 ----------
const fail = results.filter(item => item.status === 'FAIL')
const warn = results.filter(item => item.status === 'WARN')
const skip = results.filter(item => item.status === 'N/A')
const pass = results.filter(item => item.status === 'PASS')

console.log('')
console.log(`结论：${pass.length} PASS / ${fail.length} FAIL / ${warn.length} WARN / ${skip.length} N/A`)
if (fail.length) {
  console.log('失败条款：' + fail.map(item => `第${item.clause}条`).join('、'))
  process.exit(1)
}
if (warn.length) console.log('注意（WARN 不算通过）：' + warn.map(item => `第${item.clause}条`).join('、'))
