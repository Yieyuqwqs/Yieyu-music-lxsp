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
      devices.push({ k: key, exp: asExp(entry.exp), at: asString(entry.at) || undefined })
    }
    const parsed = Date.parse(asString(data.updatedAt))
    return { updatedAt: Number.isNaN(parsed) ? 0 : parsed, devices }
  } catch {
    return null
  }
}

export const parseBlacklist = (text: string): { updatedAt: number, keys: string[] } | null => {
  try {
    const data = JSON.parse(String(text ?? '')) as { updatedAt?: unknown, keys?: unknown }
    if (!Array.isArray(data.keys)) return null
    const keys = data.keys.map(item => normalizeCode(asString(item)).toLowerCase()).filter(key => key.length === 64)
    const parsed = Date.parse(asString(data.updatedAt))
    return { updatedAt: Number.isNaN(parsed) ? 0 : parsed, keys }
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
    return {
      v: 1,
      k: key,
      exp: asExp(data.exp),
      code,
      bound: asString(data.bound),
      via: (data.via === 'migration' || data.via === 'offline') ? data.via : 'whitelist',
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
    case 'active': return '已授权'
    case 'expired': return '授权已到期'
    case 'banned': return '已封禁'
    case 'tampered': return '系统时间异常'
    case 'no_biometric': return '指纹不可用'
    default: return '授权不可用'
  }
}
