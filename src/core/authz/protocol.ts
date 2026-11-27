// 授权协议（纯函数：无网络、无原生模块、无 React）
//
// 这里的每一个函数都能在 node 里直接单测（tests/authz），改动等于改协议：
//   · 白名单 / 黑名单 JSON 的形状
//   · 本机令牌（Keystore 里存的那份 JSON）
//   · 离线授权串（管理端 RSA 私钥签名，客户端用内置公钥验签）
//   · 状态机：拿到「是否有令牌 / 是否在白名单 / 是否被封禁」后该显示什么

export type LicenseStatus =
  | 'boot'
  | 'none'
  | 'ready'
  | 'locked'
  | 'review'
  | 'active'
  | 'expired'
  | 'banned'
  | 'tampered'
  | 'no_biometric'
  | 'error'

export type BindVia = 'whitelist' | 'migration' | 'offline'

/** 白名单条目：k 是 HMAC 后的条目键，exp 为 null = 永久 */
export interface WhitelistEntry {
  k: string
  exp: string | null
  at?: string
  /** 绑定 QQ 的掩码（123***89），公开文件里只能看到这个 */
  qq?: string
  /** QQ 的 HMAC 键：按 QQ 封禁/反查都靠它（公开文件里看不到原号） */
  qk?: string
  /** 昵称（能查到就记，查不到留空，给管理员认人用） */
  nick?: string
  /** pending = 用户提交了申请、还没人工审核；缺省/approved = 已开通 */
  status?: 'pending' | 'approved'
}

/** 本机令牌（加密后落 Keystore，明文只在内存里） */
export interface AuthzToken {
  v: 1
  /** 条目键：解出来必须和本机当前算出来的一致，否则视为拷来的令牌 */
  k: string
  /** 到期时间（ISO），null = 永久 */
  exp: string | null
  /** 绑定时的设备码（展示与排查用） */
  code: string
  /** 绑定时间 ISO */
  bound: string
  via: BindVia
  /** 绑定时填的 QQ（掩码展示 + HMAC 键，换机/封禁都靠它） */
  qqMask?: string
  qqKey?: string
}

/* --------------------------- QQ 绑定 --------------------------- */
//
// 为什么要绑 QQ：设备码只认机器，用户换个手机就换了个身份；
// 绑一个必填的 QQ 号之后，「这个人是谁 / 封哪个人」才有抓手。
// 公开的名单文件里只放掩码 + HMAC，不放原号。

/** 只留数字 */
export const normalizeQQ = (raw: unknown) => String(raw ?? '').replace(/[^0-9]/g, '')

/** 5~12 位、不以 0 开头（老号 5~10 位，新号 11~12 位） */
export const isValidQQ = (qq: string) => /^[1-9][0-9]{4,11}$/.test(String(qq ?? ''))

/** 展示用掩码：1234***89 */
export const maskQQ = (qq: string): string => {
  const text = normalizeQQ(qq)
  if (text.length <= 4) return text.replace(/\d(?=\d)/g, '*')
  if (text.length <= 6) return text.slice(0, 1) + '***' + text.slice(-2)
  return text.slice(0, 3) + '***' + text.slice(-2)
}

export const DAY_MS = 86400000
export const PERMANENT_EXP_TOKEN = '20991231'
export const OFFLINE_AUTH_PREFIX = 'YEYA'
export const MIGRATION_PREFIX = 'YMG1'

/** 去掉分隔符、统一大写 */
export const normalizeCode = (raw: unknown) => String(raw ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase()

/** 剩余天数（永久返回 null） */
export const daysLeftOf = (exp: string | null, now = Date.now()): number | null => {
  if (!exp) return null
  const ts = Date.parse(exp)
  if (Number.isNaN(ts)) return null
  return Math.ceil((ts - now) / DAY_MS)
}

export const isExpired = (exp: string | null, now = Date.now()): boolean => {
  if (!exp) return false
  const ts = Date.parse(exp)
  if (Number.isNaN(ts)) return false
  return now > ts
}

/* --------------------------- 到期日 token（YYYYMMDD） --------------------------- */

/** ISO → YYYYMMDD；永久/非法 → 20991231 */
export const toExpToken = (expiresAt: string | null): string => {
  if (!expiresAt) return PERMANENT_EXP_TOKEN
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return PERMANENT_EXP_TOKEN
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}

/** YYYYMMDD → ISO（当天 23:59:59 UTC）；永久/非法 → null */
export const fromExpToken = (token: string): string | null => {
  if (!token || token === PERMANENT_EXP_TOKEN || token === '00000000' || token >= PERMANENT_EXP_TOKEN) return null
  if (!/^\d{8}$/.test(token)) return null
  const ts = Date.parse(`${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}T23:59:59Z`)
  return Number.isNaN(ts) ? null : new Date(ts).toISOString()
}

/* --------------------------- 授权申请码 --------------------------- */
//
// 客户端没有 GitHub 写权限（有的话等于把白名单写权限发给所有人），
// 所以「用户确认 QQ → 提交申请」这一步做成一段可复制的申请码：
//   YQR1.<hex(JSON)>.<hex(HMAC,前 32 位)>
// 管理端粘贴后校验 HMAC、展示 QQ/头像，再决定「通过」还是「待审核/拒绝」。

export const REQUEST_PREFIX = 'YQR1'

export interface AuthzRequest {
  v: 1
  qq: string
  nick: string
  code: string
  ts: number
}

/**
 * 纯 JS 的 Utf-8 编解码 + hex。
 *
 * ⚠️ 不许用 TextEncoder / TextDecoder：Hermes 上没有这两个全局对象，
 * 真机上会直接报 "Property 'TextEncoder' doesn't exist"（Aurora-66 的 bug）。
 */
export const utf8ToHex = (text: string): string => {
  let out = ''
  const source = String(text ?? '')
  for (let i = 0; i < source.length; i++) {
    let code = source.charCodeAt(i)
    // 代理对（emoji 等）合成一个码点
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
      const low = source.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    const bytes: number[] = []
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  }
  return out
}

export const hexToUtf8 = (hex: string): string => {
  const clean = String(hex ?? '').replace(/[^0-9a-fA-F]/g, '')
  if (clean.length % 2 !== 0) return ''
  let out = ''
  let i = 0
  while (i < clean.length) {
    const byte = parseInt(clean.slice(i, i + 2), 16)
    if (byte < 0x80) { out += String.fromCharCode(byte); i += 2; continue }
    if (byte >= 0xc0 && byte < 0xe0) {
      out += String.fromCharCode(((byte & 0x1f) << 6) | (parseInt(clean.slice(i + 2, i + 4), 16) & 0x3f))
      i += 4
      continue
    }
    if (byte >= 0xe0 && byte < 0xf0) {
      out += String.fromCharCode(((byte & 0x0f) << 12) | ((parseInt(clean.slice(i + 2, i + 4), 16) & 0x3f) << 6) | (parseInt(clean.slice(i + 4, i + 6), 16) & 0x3f))
      i += 6
      continue
    }
    const code = ((byte & 0x07) << 18) | ((parseInt(clean.slice(i + 2, i + 4), 16) & 0x3f) << 12) |
      ((parseInt(clean.slice(i + 4, i + 6), 16) & 0x3f) << 6) | (parseInt(clean.slice(i + 6, i + 8), 16) & 0x3f)
    const offset = code - 0x10000
    out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
    i += 8
  }
  return out
}

export const packRequest = (request: AuthzRequest, macHex: string): string =>
  `${REQUEST_PREFIX}.${utf8ToHex(JSON.stringify(request))}.${String(macHex).slice(0, 32)}`

export const unpackRequest = (raw: string): { request: AuthzRequest, macHex: string, bodyHex: string } | null => {
  const text = String(raw ?? '').trim()
  const parts = text.split('.')
  if (parts.length !== 3) return null
  if (parts[0].toUpperCase() !== REQUEST_PREFIX) return null
  if (!/^[0-9a-fA-F]+$/.test(parts[1]) || parts[1].length % 2 !== 0) return null
  if (!/^[0-9a-fA-F]{32}$/.test(parts[2])) return null
  try {
    const data = JSON.parse(hexToUtf8(parts[1])) as AuthzRequest
    if (!data || data.v !== 1) return null
    const qq = normalizeQQ(data.qq)
    if (!isValidQQ(qq)) return null
    return {
      request: { v: 1, qq, nick: String(data.nick ?? '').slice(0, 40), code: normalizeCode(data.code), ts: Number(data.ts) || 0 },
      macHex: parts[2].toLowerCase(),
      bodyHex: parts[1].toLowerCase(),
    }
  } catch {
    return null
  }
}

/* --------------------------- 离线授权串（RSA 签名） --------------------------- */

/** 待签名内容：设备码 + 到期日 */
export const buildOfflineAuthPayload = (deviceCode: string, expToken: string) =>
  `YIEYU-AUTH|v4|dev=${normalizeCode(deviceCode)}|exp=${expToken}`

export const packOfflineAuth = (expToken: string, signatureHex: string) =>
  `${OFFLINE_AUTH_PREFIX}.${expToken}.${signatureHex.toLowerCase()}`

export const unpackOfflineAuth = (raw: string): { expToken: string, signatureHex: string } | null => {
  const text = String(raw ?? '').trim()
  const parts = text.split('.')
  if (parts.length !== 3) return null
  if (parts[0].toUpperCase() !== OFFLINE_AUTH_PREFIX) return null
  if (!/^\d{8}$/.test(parts[1])) return null
  if (!/^[0-9a-fA-F]{256,512}$/.test(parts[2]) || parts[2].length % 2 !== 0) return null
  return { expToken: parts[1], signatureHex: parts[2].toLowerCase() }
}

/* --------------------------- 云端清单 --------------------------- */

const asString = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback

const asExp = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/** 白名单容错解析：坏条目跳过，绝不让一个手滑的逗号把所有人锁在门外 */
export const parseWhitelist = (text: string): { updatedAt: number, devices: WhitelistEntry[] } | null => {
  try {
    const data = JSON.parse(String(text ?? '')) as { updatedAt?: unknown, devices?: unknown }
    if (!Array.isArray(data.devices)) return null
    const devices: WhitelistEntry[] = []
    for (const item of data.devices) {
      if (!item || typeof item !== 'object') continue
      const entry = item as { k?: unknown, exp?: unknown, at?: unknown }
      const key = normalizeCode(asString(entry.k)).toLowerCase()
      if (key.length !== 64) continue
      const qk = normalizeCode(asString((entry as { qk?: unknown }).qk)).toLowerCase()
      devices.push({
        k: key,
        exp: asExp(entry.exp),
        at: asString(entry.at) || undefined,
        qq: asString((entry as { qq?: unknown }).qq) || undefined,
        qk: qk.length === 64 ? qk : undefined,
        nick: asString((entry as { nick?: unknown }).nick) || undefined,
        status: (entry as { status?: unknown }).status === 'pending' ? 'pending' : 'approved',
      })
    }
    const parsed = Date.parse(asString(data.updatedAt))
    return { updatedAt: Number.isNaN(parsed) ? 0 : parsed, devices }
  } catch {
    return null
  }
}

export const parseBlacklist = (text: string): { updatedAt: number, keys: string[], qkeys: string[] } | null => {
  try {
    const data = JSON.parse(String(text ?? '')) as { updatedAt?: unknown, keys?: unknown, qkeys?: unknown }
    const toKeys = (value: unknown) => Array.isArray(value)
      ? value.map(item => normalizeCode(asString(item)).toLowerCase()).filter(key => key.length === 64)
      : []
    if (!Array.isArray(data.keys) && !Array.isArray(data.qkeys)) return null
    const parsed = Date.parse(asString(data.updatedAt))
    return {
      updatedAt: Number.isNaN(parsed) ? 0 : parsed,
      keys: toKeys(data.keys),
      qkeys: toKeys(data.qkeys),
    }
  } catch {
    return null
  }
}

export const findEntry = (devices: WhitelistEntry[], entryKey: string): WhitelistEntry | null => {
  const key = normalizeCode(entryKey).toLowerCase()
  if (!key) return null
  return devices.find(entry => entry.k === key) ?? null
}

/* --------------------------- 本机令牌 --------------------------- */

export const encodeToken = (token: AuthzToken) => JSON.stringify(token)

export const decodeToken = (raw: string): AuthzToken | null => {
  try {
    const data = JSON.parse(String(raw ?? '')) as Partial<AuthzToken>
    if (!data || data.v !== 1) return null
    const key = normalizeCode(asString(data.k)).toLowerCase()
    if (key.length !== 64) return null
    const code = normalizeCode(asString(data.code))
    if (code.length < 8) return null
    const qqKey = normalizeCode(asString((data as { qqKey?: unknown }).qqKey)).toLowerCase()
    return {
      v: 1,
      k: key,
      exp: asExp(data.exp),
      code,
      bound: asString(data.bound),
      via: (data.via === 'migration' || data.via === 'offline') ? data.via : 'whitelist',
      qqMask: asString((data as { qqMask?: unknown }).qqMask) || undefined,
      qqKey: qqKey.length === 64 ? qqKey : undefined,
    }
  } catch {
    return null
  }
}

/* --------------------------- 状态机 --------------------------- */

export interface EvaluateInput {
  /** 授权核自检是否通过 */
  nativeOk: boolean
  /** 指纹硬件 + 已录入 */
  biometricOk: boolean
  biometricMessage?: string
  /** 本机是否有加密令牌 */
  hasToken: boolean
  /** 解出来的令牌（未验证指纹时为 null） */
  token: AuthzToken | null
  /** 云端白名单里有没有本机条目 */
  entry: WhitelistEntry | null
  /** 云端清单是不是新鲜拉到的（不是缓存） */
  cloudFresh: boolean
  /** 本机条目是否在黑名单里 */
  banned: boolean
  /** 云端条目是不是还在人工审核（pending） */
  entryPending?: boolean
  /** 绑定的 QQ 是否在黑名单里（换设备也要拦） */
  qqBanned?: boolean
  /** 系统时间被调回 */
  clockSkew: boolean
}

export interface EvaluateResult {
  status: LicenseStatus
  message: string
  daysLeft: number | null
  exp: string | null
}

const result = (status: LicenseStatus, message: string, exp: string | null = null, now = Date.now()): EvaluateResult =>
  ({ status, message, exp, daysLeft: daysLeftOf(exp, now) })

/**
 * 决定当前应该处于什么状态。
 *
 * 关键取舍：
 * · 有令牌但没验证指纹 → locked（界面上就是「按指纹进入」）
 * · 在线白名单把本机删了 → 白名单开通的令牌作废（管理员收回），只在「新鲜拉取」时生效，防止断网误伤
 * · 在线白名单的到期日和令牌不一致 → ready（重新验证指纹同步一次）
 */
export const evaluate = (input: EvaluateInput, now = Date.now()): EvaluateResult => {
  if (!input.nativeOk) return result('error', '授权模块自检失败，请更新到最新版本', null, now)
  if (input.banned) return result('banned', '本机授权已被封禁，请联系管理员', null, now)
  if (input.qqBanned) return result('banned', '绑定的 QQ 已被封禁，换设备也无法使用', null, now)
  if (input.clockSkew) return result('tampered', '检测到系统时间被调回，请校准时间后重试', null, now)
  if (!input.biometricOk) return result('no_biometric', input.biometricMessage || '本机没有可用的指纹，请先在系统设置里录入', null, now)

  const tokenExp = input.token?.exp ?? null
  const entryExp = input.entry?.exp ?? null

  if (input.hasToken) {
    // 只有「白名单开通」的令牌才受云端撤权约束；迁移码/离线串本来就是给
    // 「云端里没有这台设备」的场景准备的，不能被云端名单一票否决（封禁走黑名单）。
    const whitelistBacked = input.token != null && input.token.via === 'whitelist'
    if (input.cloudFresh && input.entry == null && whitelistBacked) {
      return result('none', '管理员已移除本机授权，请把设备码重新发给管理员', null, now)
    }
    const effectiveExp = input.cloudFresh && input.entry ? entryExp : tokenExp
    if (isExpired(effectiveExp, now)) return result('expired', '授权已到期，请联系管理员续期', effectiveExp, now)
    if (input.token == null) {
      return result('locked', '已绑定本机，验证指纹后进入', effectiveExp, now)
    }
    if (input.cloudFresh && input.entry && (entryExp ?? null) !== (tokenExp ?? null)) {
      return result('ready', '授权信息有变更，请重新验证指纹同步', entryExp, now)
    }
    return result('active', entryExp == null && tokenExp == null ? '已授权，永久有效' : '已授权', effectiveExp, now)
  }

  if (input.cloudFresh && input.entry) {
    if (input.entryPending) return result('review', '已提交授权申请，等待管理员人工审核', entryExp, now)
    if (isExpired(entryExp, now)) return result('expired', '授权已到期，请联系管理员续期', entryExp, now)
    return result('ready', '管理员已授权，去绑定本机指纹即可使用', entryExp, now)
  }

  return result('none', '还没有授权：把设备码发给管理员开通', null, now)
}

/** 状态是否允许进入主界面（含「已解锁」） */
export const isUsableStatus = (status: LicenseStatus) => status === 'active'

/** 状态文案（授权页、授权中心共用） */
export const statusText = (status: LicenseStatus): string => {
  switch (status) {
    case 'boot': return '正在检查授权…'
    case 'none': return '未授权'
    case 'ready': return '待绑定指纹'
    case 'locked': return '待验证指纹'
    case 'review': return '待管理员审核'
    case 'active': return '已授权'
    case 'expired': return '授权已到期'
    case 'banned': return '已封禁'
    case 'tampered': return '系统时间异常'
    case 'no_biometric': return '指纹不可用'
    default: return '授权不可用'
  }
}
