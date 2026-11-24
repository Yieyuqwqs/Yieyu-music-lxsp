#!/usr/bin/env node
/**
 * 一键部署到 Cloudflare Workers（不依赖 wrangler / npm）
 *
 * 用法：
 *   CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy node deploy.mjs
 *   （可选）SCRIPT_NAME=listening-room
 *
 * 做了什么：
 *   1. node build.mjs 把 src/*.ts 转成 dist/*.js
 *   2. PUT /accounts/{acc}/workers/scripts/{name}（multipart：metadata + 四个模块）
 *   3. 打开 workers.dev 子域
 *   4. 冒烟：建房 → 加入 → 取快照，打印可用的 API 地址
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const root = dirname(fileURLToPath(import.meta.url))
const TOKEN = process.env.CF_API_TOKEN
const ACCOUNT = process.env.CF_ACCOUNT_ID
const NAME = process.env.SCRIPT_NAME || 'listening-room'
const COMPAT = process.env.COMPAT_DATE || '2026-01-01'

if (!TOKEN || !ACCOUNT) {
  console.log('需要环境变量：CF_API_TOKEN（Workers Scripts:Edit）与 CF_ACCOUNT_ID（32 位账号 ID）')
  console.log('获取：Cloudflare Dashboard → My Profile → API Tokens → Create Token → 模板「Edit Cloudflare Workers」')
  process.exit(1)
}

const call = (method, path, body, contentType) => new Promise((resolve, reject) => {
  const payload = body
  const req = https.request({
    hostname: 'api.cloudflare.com',
    path: `/client/v4${path}`,
    method,
    headers: Object.assign(
      { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'dsh-agent' },
      payload ? { 'Content-Type': contentType || 'application/json', 'Content-Length': payload.length } : {},
    ),
  }, res => {
    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let json = null
      try { json = text ? JSON.parse(text) : null } catch (error) { json = null }
      if (res.statusCode >= 200 && res.statusCode < 300 && json?.success !== false) return resolve(json)
      reject(new Error(`${method} ${path} → ${res.statusCode}: ${text.slice(0, 400)}`))
    })
  })
  req.setTimeout(60000, () => req.destroy(new Error('timeout')))
  req.on('error', reject)
  if (payload) req.write(payload)
  req.end()
})

const multipart = (parts) => {
  const boundary = '----dsh' + Math.random().toString(16).slice(2)
  const chunks = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    if (part.filename) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`))
      chunks.push(Buffer.from(`Content-Type: ${part.type || 'application/javascript+module'}\r\n\r\n`))
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`))
    }
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value)))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

const main = async() => {
  console.log('[1/4] 构建 dist/*.js')
  execFileSync(process.execPath, [join(root, 'build.mjs')], { stdio: 'inherit' })

  const modules = ['index.js', 'protocol.js', 'clock.js', 'room-do.js']
  const metadata = {
    main_module: 'index.js',
    compatibility_date: COMPAT,
    bindings: [
      { type: 'durable_object_namespace', name: 'ROOMS', class_name: 'ListeningRoomDO' },
    ],
    migrations: [{ tag: 'v1', new_sqlite_classes: ['ListeningRoomDO'] }],
  }

  console.log('[2/4] 上传 Worker')
  const parts = [{ name: 'metadata', value: JSON.stringify(metadata), type: 'application/json' }]
  for (const file of modules) {
    parts.push({ name: file, filename: file, value: readFileSync(join(root, 'dist', file)) })
  }
  const form = multipart(parts)
  await call('PUT', `/accounts/${ACCOUNT}/workers/scripts/${NAME}`, form.body, form.contentType)
  console.log('      已上传')

  console.log('[3/4] 打开 workers.dev 子域')
  await call('POST', `/accounts/${ACCOUNT}/workers/scripts/${NAME}/subdomain`, Buffer.from(JSON.stringify({ enabled: true, previews_enabled: false })))
  const sub = await call('GET', `/accounts/${ACCOUNT}/workers/subdomain`)
  const subdomain = sub?.result?.subdomain
  const baseUrl = subdomain ? `https://${NAME}.${subdomain}.workers.dev` : null
  console.log('      ' + (baseUrl ?? '（拿不到子域，去 Dashboard 看一眼）'))

  if (!baseUrl) return

  console.log('[4/4] 冒烟：建房 → 加入 → 快照')
  const created = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' })
  const createdJson = await created.json()
  if (!createdJson?.ok) throw new Error('建房失败：' + JSON.stringify(createdJson).slice(0, 200))
  const roomId = createdJson.data.roomId
  const joined = await fetch(`${baseUrl}/api/rooms/${roomId}/join`, { method: 'POST' })
  const joinedJson = await joined.json()
  if (!joinedJson?.ok) throw new Error('加入失败：' + JSON.stringify(joinedJson).slice(0, 200))
  const state = await fetch(`${baseUrl}/api/rooms/${roomId}/state`)
  const stateJson = await state.json()

  console.log('\n部署完成 ✅')
  console.log('  地址：' + baseUrl)
  console.log('  冒烟：roomId=' + roomId + ' role=' + joinedJson.data.role + ' 成员数=' + (stateJson?.data?.state?.members?.length ?? 0))
  console.log('\n在 App 里：设置 → 一起听 → 服务器地址填 ' + baseUrl)
}

main().catch(error => {
  console.error('部署失败：', error.message)
  process.exitCode = 1
})
