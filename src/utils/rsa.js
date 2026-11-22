// 纯 JS RSA（PKCS#1 v1.5 + SHA-256）与 Base32，用于离线卡密签名/校验
// 不依赖原生模块，Hermes（RN 0.73）支持 BigInt
import { sha256 } from './sha256'

const DIGEST_INFO_SHA256 = '3031300d060960864801650304020105000420'
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const hexToBytes = (hex) => {
  const clean = hex.replace(/^0x/, '')
  const out = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
  return out
}

export const bytesToHex = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s
}

const toBigInt = (hex) => {
  const clean = hex.replace(/^0x/, '').replace(/^0+(?=.)/, '')
  return BigInt('0x' + (clean.length ? clean : '0'))
}

const bigIntToHex = (value, bytes) => value.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2)

/** 快速幂取模 */
const modPow = (base, exp, mod) => {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    b = (b * b) % mod
    e >>= 1n
  }
  return result
}

export const base32Encode = (bytes) => {
  let out = ''
  let bits = 0
  let value = 0
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export const base32Decode = (str) => {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '')
  const out = []
  let bits = 0
  let value = 0
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_ALPHABET.indexOf(clean[i])
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** PKCS#1 v1.5 编码后的待签名整数（EM） */
const buildEM = (modulusBytes, message) => {
  const digest = hexToBytes(sha256(message))
  const t = hexToBytes(DIGEST_INFO_SHA256 + bytesToHex(digest))
  if (modulusBytes < t.length + 11) throw new Error('密钥长度不足')
  const em = new Uint8Array(modulusBytes)
  em[0] = 0x00
  em[1] = 0x01
  const psLen = modulusBytes - t.length - 3
  for (let i = 0; i < psLen; i++) em[2 + i] = 0xff
  em[2 + psLen] = 0x00
  em.set(t, 3 + psLen)
  return em
}

/**
 * 用私钥签名（管理端）
 * @param {{n: string, d: string, e?: string}} privateKey hex 形式
 * @param {string} message
 * @returns {string} 签名的 hex（长度 = 模长）
 */
export const rsaSign = (privateKey, message) => {
  const modBytes = Math.ceil(privateKey.n.length / 2)
  const em = buildEM(modBytes, message)
  const m = toBigInt(bytesToHex(em))
  const s = modPow(m, toBigInt(privateKey.d), toBigInt(privateKey.n))
  return bigIntToHex(s, modBytes)
}

/**
 * 用公钥验签（客户端）
 * @param {{n: string, e: string}} publicKey hex 形式
 * @param {string} message
 * @param {string} signatureHex
 * @returns {boolean}
 */
export const rsaVerify = (publicKey, message, signatureHex) => {
  try {
    const modBytes = Math.ceil(publicKey.n.length / 2)
    const sigBytes = hexToBytes(signatureHex)
    if (sigBytes.length !== modBytes) return false
    const m = modPow(toBigInt('0x' + signatureHex.replace(/^0x/, '')), toBigInt(publicKey.e), toBigInt(publicKey.n))
    const em = hexToBytes(bigIntToHex(m, modBytes))
    if (em[0] !== 0x00 || em[1] !== 0x01) return false
    let i = 2
    while (i < em.length && em[i] === 0xff) i++
    if (em[i] !== 0x00) return false
    const t = em.slice(i + 1)
    const expected = hexToBytes(DIGEST_INFO_SHA256 + sha256(message))
    if (t.length !== expected.length) return false
    for (let k = 0; k < t.length; k++) if (t[k] !== expected[k]) return false
    return true
  } catch {
    return false
  }
}
