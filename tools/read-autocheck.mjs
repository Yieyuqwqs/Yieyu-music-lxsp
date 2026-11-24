#!/usr/bin/env node
/**
 * 读 App 自动写入的核验结果（宪法第十二条：agent 自己看，不问人）
 * 用法: node tools/read-autocheck.mjs [路径]
 */
import { readFileSync, existsSync } from "node:fs"
const file = process.argv[2] || "/sdcard/lxsp-autocheck.json"
if (!existsSync(file)) {
  console.log("NOT-YET:", file, "还不存在（App 尚未产生记录）")
  process.exit(2)
}
const data = JSON.parse(readFileSync(file, "utf8"))
console.log("updatedAt:", data.updatedAt, "| 记录数:", data.records.length)
for (const r of data.records.slice(-10)) {
  console.log(`  #${r.seq} ${r.at} duration=${r.durationMs}ms position=${r.positionMs}ms state=${r.state} ok=${r.ok}`)
}
const last = data.records[data.records.length - 1]
process.exit(last && last.ok ? 0 : 1)
