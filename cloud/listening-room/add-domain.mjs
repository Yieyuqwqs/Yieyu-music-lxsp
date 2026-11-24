#!/usr/bin/env node
/**
 * 给已部署的 Worker 绑自定义域名（免费域名走这条）
 *
 * 用法：
 *   CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy node add-domain.mjs room.yieyu.mooo.com
 *
 * 做三件事：
 *   1. 把域名加进 Cloudflare 账号（如果还没有这个 zone），并打印需要去注册商那边填的 NS
 *   2. 等 zone 变成 active（NS 生效）
 *   3. 给 listening-room 这个 Worker 加自定义域名，并冒烟
 *
 * 注意：免费二级域名（afraid.org / FreeDNS 这类）要把「子域名的 NS」指到下面打印的 NS，
 *     而不是 A 记录，Cloudflare 才会认这个 zone。
 */
import { execFileSync } from 'node:child_process'

const TOKEN = process.env.CF_API_TOKEN
const ACCOUNT = process.env.CF_ACCOUNT_ID
const HOSTNAME = (process.argv[2] || '').trim()
const SCRIPT = process.env.SCRIPT_NAME || 'listening-room'
const API = 'https://api.cloudflare.com/client/v4'

if (!TOKEN || !ACCOUNT || !HOSTNAME) {
  console.log('用法：CF_API_TOKEN=… CF_ACCOUNT_ID=… node add-domain.mjs room.example.com')
  process.exit(1)
}

const curl = (args) => {
  try { return execFileSync('curl', ['-sS', '--max-time', '60', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { throw new Error(`curl 失败：${error.message}`) }
}

const call = (method, path, body) => {
  const args = ['-X', method, '-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Content-Type: application/json']
  if (body) args.push('--data', JSON.stringify(body))
  args.push(`${API}${path}`)
  const text = curl(args)
  let json
  try { json = JSON.parse(text) } catch (error) { throw new Error(`${method} ${path}：返回不是 JSON：${text.slice(0, 200)}`) }
  if (json.success === false) throw new Error(`${method} ${path}：${JSON.stringify(json.errors ?? json).slice(0, 400)}`)
  return json
}

// 找出 zone 的根域（room.a.mooo.com → 先试 a.mooo.com，再试 mooo.com）
const zoneCandidates = () => {
  const parts = HOSTNAME.split('.')
  const list = []
  for (let i = 1; i < parts.length - 1; i++) list.push(parts.slice(i).join('.'))
  return list
}

const main = () => {
  let zone = null
  for (const candidate of zoneCandidates()) {
    const found = call('GET', `/zones?name=${encodeURIComponent(candidate)}&account.id=${ACCOUNT}`)
    if (found.result?.length) { zone = found.result[0]; break }
  }

  if (!zone) {
    const root = zoneCandidates()[0]
    console.log(`[1/3] 账号里还没有 ${root}，现在创建 zone`)
    const created = call('POST', '/zones', { name: root, account: { id: ACCOUNT }, type: 'full', jump_start: false })
    zone = created.result
    console.log(`      已创建：${zone.name}（状态 ${zone.status}）`)
    console.log('\n  ⚠️ 下一步：去你的免费域名后台（afraid.org 等），把子域名的 NS 记录改成：')
    for (const ns of zone.name_servers ?? []) console.log('      ' + ns)
    console.log('  改完等几分钟，再重跑这条命令。\n')
    return
  }

  console.log(`[1/3] zone 已存在：${zone.name}（${zone.status}）`)
  if (zone.status !== 'active') {
    console.log('      zone 还没激活，把这些 NS 填到你的免费域名后台后重跑：')
    for (const ns of zone.name_servers ?? []) console.log('      ' + ns)
    return
  }

  console.log(`[2/3] 给 Worker ${SCRIPT} 绑定 ${HOSTNAME}`)
  const bound = call('PUT', `/accounts/${ACCOUNT}/workers/domains`, {
    environment: 'production',
    hostname: HOSTNAME,
    service: SCRIPT,
    zone_id: zone.id,
  })
  console.log('      绑定成功：' + (bound.result?.hostname ?? HOSTNAME))

  console.log('[3/3] 冒烟（可能需要 1-2 分钟生效）')
  const url = `https://${HOSTNAME}`
  for (let i = 0; i < 6; i++) {
    try {
      const text = curl(['-X', 'POST', `${url}/api/rooms`])
      const json = JSON.parse(text)
      if (json?.ok) {
        console.log(`\n完成 ✅  ${url}`)
        console.log('  roomId=' + json.data.roomId + '（App 里填这个地址即可）')
        return
      }
    } catch (error) { /* 继续重试 */ }
    execFileSync('sleep', ['10'])
  }
  console.log('\n绑定完成了，但云端还没生效或本机解析不到，稍后自己刷一下：' + url)
}

try { main() } catch (error) { console.error('失败：', error.message); process.exitCode = 1 }
