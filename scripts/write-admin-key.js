#!/usr/bin/env node
// CI 专用：从环境变量 LICENSE_KEYPAIR_B64 还原管理端私钥文件
// 私钥永远不进仓库，只在构建管理端时注入
const fs = require('fs')
const path = require('path')

const b64 = process.env.LICENSE_KEYPAIR_B64
if (!b64) {
  console.error('缺少 LICENSE_KEYPAIR_B64，拒绝构建管理端（私钥必须由 Secret 注入）')
  process.exit(1)
}
const kp = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
if (!kp.n || !kp.d) {
  console.error('密钥数据不完整')
  process.exit(1)
}
const content = `// ⚠️ 自动生成（CI 注入）：管理端私钥，严禁外传、严禁提交
export const LICENSE_PRIVATE_KEY = {
  e: '${kp.e}',
  n: '${kp.n}',
  d: '${kp.d}',
} as const
`
const out = path.join(__dirname, '..', 'src', 'screens', 'AdminApp', 'signing.ts')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, content)
console.log('✅ 已写入管理端私钥（仅构建期存在）')
