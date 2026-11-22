#!/usr/bin/env node
/**
 * 校验 APK 签名证书指纹（不依赖 apksigner/keytool，直接解析 APK Signing Block 的 v2/v3 签名）
 *
 * 用法: node scripts/verify-apk-signature.js <apk> [期望的 SHA-256 指纹]
 * 期望指纹也可用环境变量 EXPECTED_CERT_SHA256 传入；不传则只打印指纹。
 * 指纹不匹配时退出码为 1。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function certFingerprint (file) {
  const buf = fs.readFileSync(file)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('未找到 EOCD，不是完整的 APK')
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const magic = Buffer.from('APK Sig Block 42')
  if (!buf.slice(cdOffset - 16, cdOffset).equals(magic)) throw new Error('未找到 APK Signing Block（仅 v1 签名的包不支持）')
  const blockSize = Number(buf.readBigUInt64LE(cdOffset - 24))
  const blockStart = cdOffset - 8 - blockSize
  const pairsEnd = cdOffset - 24
  let p = blockStart + 8
  const blocks = {}
  while (p < pairsEnd) {
    const len = Number(buf.readBigUInt64LE(p)); p += 8
    const id = buf.readUInt32LE(p); p += 4
    blocks[id] = buf.slice(p, p + len - 4)
    p += len - 4
  }
  const readLen = (b, off) => [b.readUInt32LE(off), off + 4]
  const certFrom = (value) => {
    let [signersLen, o] = readLen(value, 0)
    const end = o + signersLen
    while (o < end) {
      let [signerLen, o2] = readLen(value, o)
      const signerEnd = o2 + signerLen
      let [sdLen, o3] = readLen(value, o2)          // signed data
      let [digestsLen, o4] = readLen(value, o3)
      o4 += digestsLen
      let [certsLen, o5] = readLen(value, o4)
      if (certsLen > 0) {
        let [cl, o6] = readLen(value, o5)
        return value.slice(o6, o6 + cl)
      }
      o = signerEnd
    }
    return null
  }
  let cert = null, scheme = ''
  if (blocks[0xf05368c0]) { cert = certFrom(blocks[0xf05368c0]); scheme = 'v3' }
  if (!cert && blocks[0x7109871a]) { cert = certFrom(blocks[0x7109871a]); scheme = 'v2' }
  if (!cert) throw new Error('签名块中没有证书')
  return { scheme, fingerprint: crypto.createHash('sha256').update(cert).digest('hex').toUpperCase() }
}

const file = process.argv[2]
const expected = (process.argv[3] || process.env.EXPECTED_CERT_SHA256 || '').replace(/:/g, '').toUpperCase()
if (!file) { console.error('用法: node scripts/verify-apk-signature.js <apk> [期望指纹]'); process.exit(2) }
let scheme, fingerprint
try {
  ({ scheme, fingerprint } = certFingerprint(file))
} catch (e) {
  console.error(`❌ ${path.basename(file)}: ${e.message}`)
  process.exit(1)
}
console.log(`${path.basename(file)}  方案 ${scheme}  证书SHA-256 ${fingerprint}`)
if (!expected) process.exit(0)
if (fingerprint !== expected) {
  console.error(`❌ 签名指纹不一致，期望 ${expected}`)
  process.exit(1)
}
console.log('✅ 指纹与固定签名一致')
