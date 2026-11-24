#!/usr/bin/env node
/**
 * 一键部署到 Cloudflare Workers（用 curl 走网络：本机 node 的 DNS 解析器不可用，curl 可以）
 *
 * 用法：
 *   CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy node deploy.mjs
 *
 * 流程：build → 上传（metadata + 4 个 ESM 模块 + DO 绑定与迁移）→ 开 workers.dev → 冒烟（建房/加入/快照）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const TOKEN = process.env.CF_API_TOKEN
const ACCOUNT = process.env.CF_ACCOUNT_ID
const NAME = process.env.SCRIPT_NAME || 'listening-room'
const COMPAT = process.env.COMPAT_DATE || '2026-01-01'
const API = 'https://api.cloudflare.com/client/v4'

if (!TOKEN || !ACCOUNT) {
  console.log('需要环境变量：CF_API_TOKEN 与 CF_ACCOUNT_ID')
  process.exit(1)
}

const curl = (args) => {
  try {
    return execFileSync('curl', ['-sS', '--max-time', '90', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(`curl 失败：${error.message}`)
  }
}

const parse = (text, what) => {
  let json = null
  try { json = JSON.parse(text) } catch (error) { json = null }
  if (!json) throw new Error(`${what}：响应不是 JSON：${text.slice(0, 300)}`)
  if (json.success === false) throw new Error(`${what}：${JSON.stringify(json.errors ?? json).slice(0, 400)}`)
  return json
}

const main = async() => {
  console.log('[1/4] 构建 dist/*.js')
  execFileSync(process.execPath, [join(root, 'build.mjs')], { stdio: 'inherit' })

  console.log('[2/4] 上传 Worker')
  const metadata = {
    main_module: 'index.js',
    compatibility_date: COMPAT,
    bindings: [{ type: 'durable_object_namespace', name: 'ROOMS', class_name: 'ListeningRoomDO' }],
    // Workers API 要的是「Actors 迁移对象」而不是数组
    migrations: { new_tag: 'v1', steps: [{ new_sqlite_classes: ['ListeningRoomDO'] }] },
  }
  const upload = curl([
    '-X', 'PUT',
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-F', `metadata=${JSON.stringify(metadata)};type=application/json`,
    '-F', `index.js=@${join(root, 'dist/index.js')};type=application/javascript+module`,
    '-F', `protocol.js=@${join(root, 'dist/protocol.js')};type=application/javascript+module`,
    '-F', `clock.js=@${join(root, 'dist/clock.js')};type=application/javascript+module`,
    '-F', `room-do.js=@${join(root, 'dist/room-do.js')};type=application/javascript+module`,
    `${API}/accounts/${ACCOUNT}/workers/scripts/${NAME}`,
  ])
  parse(upload, '上传 Worker')
  console.log('      已上传')

  console.log('[3/4] 打开 workers.dev 子域')
  const subdomainToggle = curl([
    '-X', 'POST',
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Content-Type: application/json',
    '--data', JSON.stringify({ enabled: true, previews_enabled: false }),
    `${API}/accounts/${ACCOUNT}/workers/scripts/${NAME}/subdomain`,
  ])
  parse(subdomainToggle, '开启子域')

  const sub = parse(curl(['-H', `Authorization: Bearer ${TOKEN}`, `${API}/accounts/${ACCOUNT}/workers/subdomain`]), '查询子域')
  const subdomain = sub?.result?.subdomain
  const baseUrl = subdomain ? `https://${NAME}.${subdomain}.workers.dev` : null
  console.log('      ' + (baseUrl ?? '（拿不到子域，请去 Dashboard 看）'))
  if (!baseUrl) return

  console.log('[4/4] 冒烟：建房 → 加入 → 快照')
  const created = parse(curl(['-X', 'POST', `${baseUrl}/api/rooms`]), '建房')
  if (!created.ok) throw new Error('建房返回 ok=false：' + JSON.stringify(created).slice(0, 200))
  const roomId = created.data.roomId
  const joined = parse(curl(['-X', 'POST', `${baseUrl}/api/rooms/${roomId}/join`]), '加入')
  const state = parse(curl([`${baseUrl}/api/rooms/${roomId}/state`]), '快照')

  console.log('\n部署完成 ✅')
  console.log('  地址：' + baseUrl)
  console.log('  冒烟：roomId=' + roomId + ' role=' + joined.data.role + ' 成员数=' + (state?.data?.state?.members?.length ?? 0) + ' anchor=' + JSON.stringify(state?.data?.state?.playback ?? {}))
  console.log('\nApp 里：设置 → 一起听 → 服务器地址填 ' + baseUrl)
}

main().catch(error => {
  console.error('部署失败：', error.message)
  process.exitCode = 1
})
