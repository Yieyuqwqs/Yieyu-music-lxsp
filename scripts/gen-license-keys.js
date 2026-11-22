#!/usr/bin/env node
/**
 * 生成卡密签名用的 RSA 密钥对（在电脑/手机本地跑，私钥绝不要提交到公开仓库）
 *
 * 用法：
 *   node scripts/gen-license-keys.js                 # 默认 2048 位，输出到 keys/
 *   node scripts/gen-license-keys.js --bits 3072
 *   node scripts/gen-license-keys.js --out keys --write-code   # 顺带写入两端的配置常量
 *
 * 产物：
 *   keys/private.pem   私钥（PKCS#8），只给管理端 App 用，务必离线保存
 *   keys/public.pem    公钥（SPKI），给客户端 App 内置
 *   keys/keypair.json  n/e/d 的 hex 形式（方便直接贴进代码）
 *
 * 注意：只要私钥泄露，任何人都能自己发卡；公钥可以随便公开。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const bits = Number(arg('bits', 2048))
const outDir = path.resolve(String(arg('out', 'keys')))
const writeCode = arg('write-code', false)
const root = path.resolve(__dirname, '..')

const b64urlToHex = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex')

console.log(`正在生成 RSA-${bits} 密钥对…`)
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: bits,
  publicExponent: 0x10001,
})

const jwkPriv = privateKey.export({ format: 'jwk' })
const jwkPub = publicKey.export({ format: 'jwk' })

const n = b64urlToHex(jwkPub.n)
const e = b64urlToHex(jwkPub.e)
const d = b64urlToHex(jwkPriv.d)
const p = jwkPriv.p ? b64urlToHex(jwkPriv.p) : undefined
const q = jwkPriv.q ? b64urlToHex(jwkPriv.q) : undefined

const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
const pubPem = publicKey.export({ type: 'spki', format: 'pem' })
const spkiDer = publicKey.export({ type: 'spki', format: 'der' })
const fingerprint = crypto.createHash('sha256').update(spkiDer).digest('hex')

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'private.pem'), privPem, { mode: 0o600 })
fs.writeFileSync(path.join(outDir, 'public.pem'), pubPem)
fs.writeFileSync(path.join(outDir, 'keypair.json'), JSON.stringify({
  bits, e, n, d, p, q, fingerprint,
}, null, 2) + '\n')

const publicCode = `// 自动生成：客户端内置公钥（可公开）
export const LICENSE_PUBLIC_KEY = {
  e: '${e}',
  n: '${n}',
} as const
`
const privateCode = `// ⚠️ 自动生成：管理端内置私钥，严禁外传、严禁提交到公开仓库
export const LICENSE_PRIVATE_KEY = {
  e: '${e}',
  n: '${n}',
  d: '${d}',
} as const
`

if (writeCode) {
  const pubPath = path.join(root, 'src', 'config', 'licenseKey.ts')
  const privPath = path.join(root, 'src', 'screens', 'AdminApp', 'privateKey.ts')
  fs.mkdirSync(path.dirname(privPath), { recursive: true })
  fs.writeFileSync(pubPath, publicCode)
  fs.writeFileSync(privPath, privateCode)
  console.log(`已写入 ${path.relative(root, pubPath)} 与 ${path.relative(root, privPath)}`)
}

console.log(`
✅ 生成完成（${bits} 位）
   指纹(SHA-256 SPKI): ${fingerprint}

文件：
   ${path.join(outDir, 'private.pem')}  ← 私钥，只给管理端
   ${path.join(outDir, 'public.pem')}   ← 公钥，给客户端
   ${path.join(outDir, 'keypair.json')}

--- 客户端 src/config/licenseKey.ts 内容 ---
${publicCode}
--- 管理端 src/screens/AdminApp/privateKey.ts 内容（不要外传） ---
${privateCode.slice(0, 260)}…（完整内容见文件）
`)
