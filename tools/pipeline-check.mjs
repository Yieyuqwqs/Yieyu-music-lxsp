#!/usr/bin/env node
/**
 * 交互式人工触发终端（宪法第十一条的落地工具）
 *
 * 用途：本机拿不到 Logcat、端点也不一定通时，由人类把**真实直链**粘进来，
 *      用 App 同一条校验管线跑一遍，并把结果写成 tests/lxsp/live-url.json，
 *      让 live.test.mjs 在下次 CI 里验证同一条链接。
 *
 * 用法：
 *   node tools/pipeline-check.mjs "https://真实直链..."
 *   node tools/pipeline-check.mjs            # 进入交互模式，粘贴后回车
 *
 * 校验内容（与 App 内一致）：
 *   1. 必须是 http(s)
 *   2. Range 请求能取到真实字节（200/206），非 HTML 错误页
 *   3. 记录 total length / accept-ranges / content-type，供质量判断
 *   4. 连续两次采样，验证链接在短时间内的稳定性（时效性）
 */
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../tests/lxsp/live-url.json', import.meta.url))

const probe = async (url, timeoutMs = 12000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-8191', 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    })
    const buffer = await response.arrayBuffer()
    return {
      ok: response.status === 200 || response.status === 206,
      status: response.status,
      bytes: buffer.byteLength,
      type: response.headers.get('content-type') ?? '',
      ranges: response.headers.get('accept-ranges') ?? '',
      length: response.headers.get('content-range') ?? response.headers.get('content-length') ?? '',
      ms: Date.now() - started,
    }
  } catch (error) {
    return { ok: false, status: 0, bytes: 0, type: '', ranges: '', length: '', ms: Date.now() - started, error: error.message }
  } finally {
    clearTimeout(timer)
  }
}

const ask = async () => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question('粘贴真实直链（回车确认）：\n> ', (answer) => { rl.close(); resolve(answer.trim()) })
  })
}

const main = async() => {
  const url = (process.argv[2] || await ask()).trim()
  if (!url) { console.error('没有输入链接'); process.exit(2) }
  if (!/^https?:\/\//i.test(url)) { console.error('不是 http(s) 链接'); process.exit(2) }

  console.log('校验 1/2 …')
  const first = await probe(url)
  console.log('校验 2/2 …（验证短时间内仍可取）')
  const second = await probe(url)

  console.log('\n结果：')
  console.log(`  HTTP     ${first.status}（第二次 ${second.status}）  ${first.status === 206 ? '部分内容（Range 生效）' : ''}`)
  console.log(`  字节     首次 ${first.bytes} ／ 二次 ${second.bytes}`)
  console.log(`  类型     ${first.type || '-'}`)
  console.log(`  范围     accept-ranges=${first.ranges || '-'}  ${first.length}`)
  console.log(`  耗时     首次 ${first.ms}ms ／ 二次 ${second.ms}ms`)
  if (first.error || second.error) console.log(`  错误     ${first.error || second.error}`)

  const usable = first.ok && second.ok && first.bytes > 1024 && second.bytes > 1024 && !/html/i.test(first.type)
  if (!usable) {
    console.log('\n判定：不可用（不会写入 live-url.json）')
    process.exit(1)
  }

  writeFileSync(OUT, JSON.stringify({
    url,
    checkedAt: new Date().toISOString(),
    status: first.status,
    bytes: first.bytes,
    type: first.type,
    ranges: first.ranges,
    length: first.length,
  }, null, 2))
  console.log(`\n判定：可用 ✅  已写入 ${OUT}`)
  console.log('现在 CI 的「人工转交的直链」用例会验证这条链接。')
}

main().catch((error) => { console.error('失败：', error.message); process.exitCode = 1 })
