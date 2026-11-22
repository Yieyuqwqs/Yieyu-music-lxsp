// 卡密（纯离线校验）
// v2 短格式（默认，16 位）：YIEYU-XXXX-XXXXX
//   · 9 位 Crockford Base32 载荷 = 45 bit：到期日 15 bit + 校验码 30 bit
//   · 到期日 0 = 永久；其余为「2020-01-01 起的天数 + 1」，精确到天（UTC）
//   · 校验码 = HMAC-SHA256(密钥, 设备码 + 到期日) 截断 30 bit
// v1 长格式（兼容旧卡，约 424 字符）：YEYU.<YYYYMMDD>.<Base32(RSA-2048 签名)>
import { hmacSha256Hex } from './hmacSha256'
import { rsaSign, rsaVerify, base32Encode, base32Decode, bytesToHex } from './rsa'
import { CARD_SECRET_HEX } from '../config/cardSecret'

export const CARD_PREFIX = 'YIEYU'
export const LEGACY_PREFIX = 'YEYU'
export const PERMANENT_EXP = '20991231'

// Crockford Base32（去掉容易混淆的 I L O U）
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const PAYLOAD_LEN = 9
const EPOCH_MS = Date.UTC(2020, 0, 1)
const DAY_MS = 86400000
const MAX_DAY = 32767
const BIT = 2 ** 30
// 45 bit 内的低 30 位：序号 8 bit + 校验码 22 bit
const SERIAL_BITS = 8
const MAC_BITS = 22
const MAC_MASK = 2 ** MAC_BITS - 1
const SERIAL_MAX = 2 ** SERIAL_BITS - 1

/** 随机序号（每次生成卡密都不一样） */
export const randomSerial = () => Math.floor(Math.random() * (SERIAL_MAX + 1))
// 45 bit 混淆掩码：让卡密看起来是随机的，也不暴露「是否永久」
const MASK = 0x0b7a5c3e19d
const MASK_HI = Math.floor(MASK / 2 ** 24)
const MASK_LO = MASK % (2 ** 24)

const xorMask = (value) => {
  const hi = Math.floor(value / 2 ** 24)
  const lo = value % (2 ** 24)
  return (hi ^ MASK_HI) * 2 ** 24 + (lo ^ MASK_LO)
}

/** 统一设备码/卡密的清洗规则 */
export const normalizeCode = (raw) => String(raw || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase()

const DAY_MS_LOCAL = DAY_MS
const fixAlphabet = (text) => text.replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V')

/* --------------------------- v2 短卡密 --------------------------- */

/** 到期时间 → 天数编码（0 = 永久） */
export const toExpDay = (expiresAt) => {
  if (!expiresAt) return 0
  const ts = new Date(expiresAt).getTime()
  if (Number.isNaN(ts)) return 0
  const utcMidnight = Math.floor(ts / DAY_MS_LOCAL) * DAY_MS_LOCAL
  const day = Math.round((utcMidnight - EPOCH_MS) / DAY_MS_LOCAL) + 1
  if (day <= 0) return 1
  return Math.min(day, MAX_DAY)
}

/** 天数编码 → 到期时间（当天 23:59:59.999 UTC）；永久返回 null */
export const fromExpDay = (day) => {
  if (!day) return null
  return new Date(EPOCH_MS + day * DAY_MS - 1).toISOString()
}

/** 待校验内容：设备码 + 到期日必须同时匹配 */
export const buildShortPayload = (deviceCode, day) => `YIEYU-CARD|v2|dev=${normalizeCode(deviceCode)}|exp=${day}`

/** v3 校验码（22 bit，含随机序号） */
const cardMacV3 = (day, serial, deviceCode) => {
  const hex = hmacSha256Hex(CARD_SECRET_HEX, buildSerialPayload(deviceCode, day, serial))
  return ((parseInt(hex.slice(0, 8), 16) >>> 2) & MAC_MASK)
}

/** v2 校验码（30 bit，无序号，仅用于校验旧卡） */
const cardMacV2 = (day, deviceCode) => {
  const hex = hmacSha256Hex(CARD_SECRET_HEX, buildShortPayload(deviceCode, day))
  return (parseInt(hex.slice(0, 8), 16) >>> 2)
}

/** v3 待校验内容：设备码 + 到期日 + 序号 */
export const buildSerialPayload = (deviceCode, day, serial) => `YIEYU-CARD|v3|dev=${normalizeCode(deviceCode)}|exp=${day}|sn=${serial}`

/** 管理端：生成 16 位短卡密（serial 不传则随机，确保每次都不一样） */
export const createCardKey = (deviceCode, expiresAt, serial) => {
  const day = toExpDay(expiresAt)
  const sn = (serial == null ? randomSerial() : serial) & SERIAL_MAX
  let value = xorMask(day * BIT + (sn * 2 ** MAC_BITS) + cardMacV3(day, sn, deviceCode))
  let body = ''
  for (let i = 0; i < PAYLOAD_LEN; i++) {
    body = ALPHABET[value % 32] + body
    value = Math.floor(value / 32)
  }
  return `${CARD_PREFIX}-${body.slice(0, 4)}-${body.slice(4)}`
}

const parseShortCard = (raw) => {
  const compact = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (compact.length !== CARD_PREFIX.length + PAYLOAD_LEN) return null
  if (compact.slice(0, CARD_PREFIX.length) !== CARD_PREFIX) return null
  const body = fixAlphabet(compact.slice(CARD_PREFIX.length))
  let value = 0
  for (const ch of body) {
    const index = ALPHABET.indexOf(ch)
    if (index < 0) return null
    value = value * 32 + index
  }
  const plain = xorMask(value)
  return { day: Math.floor(plain / BIT), low: plain % BIT }
}

const verifyShortCard = (raw, deviceCode) => {
  const parsed = parseShortCard(raw)
  if (!parsed) throw new Error('卡密格式不正确，应为 YIEYU-XXXX-XXXXX')
  if (parsed.day > MAX_DAY) throw new Error('卡密格式不正确，应为 YIEYU-XXXX-XXXXX')
  const serial = Math.floor(parsed.low / 2 ** MAC_BITS)
  const mac22 = parsed.low % 2 ** MAC_BITS
  const okV3 = cardMacV3(parsed.day, serial, deviceCode) === mac22
  const okV2 = cardMacV2(parsed.day, deviceCode) === parsed.low
  if (!okV3 && !okV2) throw new Error('卡密无效或不属于本机')
  const expiresAt = fromExpDay(parsed.day)
  if (expiresAt && Date.now() > Date.parse(expiresAt)) throw new Error('卡密已过期')
  return { expiresAt, expToken: parsed.day === 0 ? 'permanent' : String(parsed.day) }
}

/* --------------------------- v1 长卡密（兼容） --------------------------- */

/** 到期日 → YYYYMMDD（永久为 20991231） */
export const toExpToken = (expiresAt) => {
  if (!expiresAt) return PERMANENT_EXP
  const d = new Date(expiresAt)
  if (Number.isNaN(d.getTime())) return PERMANENT_EXP
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** YYYYMMDD → ISO 时间（当天 23:59:59Z），永久返回 null */
export const fromExpToken = (token) => {
  if (!token || token === PERMANENT_EXP || token === '00000000' || token >= '20991231') return null
  const y = token.slice(0, 4)
  const m = token.slice(4, 6)
  const d = token.slice(6, 8)
  const ts = Date.parse(`${y}-${m}-${d}T23:59:59Z`)
  return Number.isNaN(ts) ? null : new Date(ts).toISOString()
}

/** 旧版待签名内容 */
export const buildPayload = (deviceCode, expToken) => `YIEYU-CARD|v1|dev=${normalizeCode(deviceCode)}|exp=${expToken}`

/** 管理端：生成旧版长卡密（仅备用，RSA 私钥） */
export const createLegacyCardKey = (privateKey, deviceCode, expiresAt) => {
  const expToken = toExpToken(expiresAt)
  const payload = buildPayload(deviceCode, expToken)
  const signature = rsaSign(privateKey, payload)
  return `${LEGACY_PREFIX}.${expToken}.${base32Encode(hexToBytesSafe(signature))}`
}

const verifyLegacyCard = (publicKey, raw, deviceCode) => {
  const parts = raw.split('.')
  if (parts.length !== 3) throw new Error('卡密格式不正确')
  const [prefix, expToken, sigB32] = parts
  if (prefix.toUpperCase() !== LEGACY_PREFIX) throw new Error('卡密格式不正确')
  if (!/^\d{8}$/.test(expToken)) throw new Error('卡密格式不正确')
  const signature = bytesToHex(base32Decode(sigB32))
  if (!signature) throw new Error('卡密格式不正确')
  const payload = buildPayload(deviceCode, expToken)
  if (!rsaVerify(publicKey, payload, signature)) throw new Error('卡密无效或不属于本机')
  const expiresAt = fromExpToken(expToken)
  if (expiresAt && Date.now() > Date.parse(expiresAt)) throw new Error('卡密已过期')
  return { expiresAt, expToken }
}

/* --------------------------- 统一入口 --------------------------- */

/** 客户端：校验卡密，通过返回 { expiresAt, expToken }，失败抛错 */
export const verifyCardKey = (publicKey, cardKey, deviceCode) => {
  const raw = String(cardKey || '').trim().replace(/\s/g, '')
  if (!raw) throw new Error('请输入卡密')
  if (raw.toUpperCase().startsWith(LEGACY_PREFIX + '.')) return verifyLegacyCard(publicKey, raw, deviceCode)
  return verifyShortCard(raw, deviceCode)
}

const hexToBytesSafe = (hex) => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}
