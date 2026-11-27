// 授权（纯离线可用的「认设备 + 认人」）
//
//   认设备：设备码 = 硬件信息派生（C++）→ 管理员填进云端白名单 → whitelist.json
//   认人  ：本机指纹解锁 Keystore 里的加密令牌，锁屏即熔断
//
// 卡密体系（16 位 YIEYU 码、对称校验码、黑名单哈希）已整体废弃。
// 这里不再有任何「手动输入卡密」的入口；用户要粘贴的只有两种：
//   · 迁移码 YMG1-xxx（老设备导出，24 小时有效，用于换机）
//   · 离线授权串 YEYA.<到期日>.<签名>（管理员用 RSA 私钥签发，没网时救急）
import { AppState } from 'react-native'

import { getData, saveData, removeData } from '@/plugins/storage'
import licenseActions from '@/store/license/action'
import licenseState from '@/store/license/state'
import {
  type AuthzToken, type BindVia, type EvaluateResult, type WhitelistEntry,
  buildOfflineAuthPayload, decodeToken, encodeToken, evaluate, findEntry, fromExpToken,
  isExpired, isUsableStatus, isValidQQ, maskQQ, normalizeCode, packRequest, parseBlacklist, parseWhitelist,
  unpackOfflineAuth, utf8ToHex,
  MIGRATION_PREFIX, daysLeftOf,
} from './authz/protocol'
import authzNative from '@/utils/nativeModules/authz'
import {
  AUTHZ_BLACKLIST_FILE, AUTHZ_CLOCK_TOLERANCE, AUTHZ_REFRESH_INTERVAL, AUTHZ_SOURCE_TIMEOUT,
  AUTHZ_SYNC_TIMEOUT, AUTHZ_USED_MIGRATION_LIMIT, AUTHZ_WHITELIST_FILE, authzFileUrl, authzRawUrl,
} from '@/config/authz'
import { ghFetchRawText } from '@/utils/ghMirror'
import { LICENSE_PUBLIC_KEY } from '@/config/licenseKey'
import { rsaVerify } from '@/utils/rsa'
import { navigations } from '@/navigation'

const KEY_MAX_SEEN = 'license.maxSeenTime'
const KEY_CLOUD_CACHE = 'license.cloudCache'
const KEY_USED_MIGRATIONS = 'license.usedMigrations'
const KEY_BANNED = 'license.bannedEntry'
const KEY_BANNED_QQ = 'license.bannedQq'
const KEY_TOKEN_HAS_QQ = 'license.tokenHasQq'

interface CloudSnapshot {
  whitelist: { updatedAt: number, devices: WhitelistEntry[] } | null
  blacklist: { updatedAt: number, keys: string[] } | null
  at: number
}

let deviceCode = ''
let entryCodeKey = ''
let tokenExists = false
/** 令牌里是否带 QQ（落盘旗标；令牌密文解锁前读不到） */
let tokenHasQQ = false
let memoryToken: AuthzToken | null = null
let nativeOk = false
let biometricOk = false
let biometricMessage = ''
let cloudFresh = false
let cloud: CloudSnapshot = { whitelist: null, blacklist: null, at: 0 }
let inited = false
let watcherStarted = false
let screenOffBound = false

const errText = (error: unknown) => {
  const value = error as { message?: string } | null
  return value?.message || '未知错误'
}

const withTimeout = <T>(promise: Promise<T>, ms: number, tip = 'timeout'): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error(tip)) }, ms)
  promise.then(
    value => { clearTimeout(timer); resolve(value) },
    error => { clearTimeout(timer); reject(error) },
  )
})

/* --------------------------- 云端清单（多源并发） --------------------------- */

/**
 * 拉一份云端清单：contents API（国内最稳）→ 反代 → 直连，全部带硬超时，
 * 候选并发赛跑（细节在 utils/ghMirror）。
 *
 * 旧实现是「每个源各发一次、等全部返回」，raw 一卡就整体拖到超时；
 * 现在任何一个候选先返回就用，其余立刻被忽略。
 */
const pullList = async <T extends { updatedAt: number }>(
  file: string,
  parse: (text: string) => T | null,
): Promise<T | null> => {
  const urls = [authzFileUrl(file), authzRawUrl(file)]
  for (const url of urls) {
    try {
      const text = await withTimeout(ghFetchRawText(url, { timeoutMs: AUTHZ_SOURCE_TIMEOUT }), AUTHZ_SYNC_TIMEOUT)
      const parsed = parse(text)
      if (parsed) return parsed
    } catch (error) {
      // 换下一种读法
    }
  }
  return null
}

const readCloudCache = async() => {
  try {
    const cached = await getData<CloudSnapshot>(KEY_CLOUD_CACHE)
    if (cached && (cached.whitelist || cached.blacklist)) {
      cloud = {
        whitelist: cached.whitelist ?? null,
        blacklist: cached.blacklist ?? null,
        at: cached.at ?? 0,
      }
    }
  } catch {}
}

const writeCloudCache = async() => {
  try {
    await saveData(KEY_CLOUD_CACHE, { ...cloud, at: Date.now() })
  } catch {}
}

/** 同步云端白名单 + 黑名单；返回是否拿到了新鲜数据 */
const syncCloud = async(): Promise<boolean> => {
  const [whitelist, blacklist] = await Promise.all([
    withTimeout(pullList(AUTHZ_WHITELIST_FILE, parseWhitelist), AUTHZ_SYNC_TIMEOUT).catch(() => null),
    withTimeout(pullList(AUTHZ_BLACKLIST_FILE, parseBlacklist), AUTHZ_SYNC_TIMEOUT).catch(() => null),
  ])
  const gotSomething = !!(whitelist || blacklist)
  if (whitelist) cloud.whitelist = whitelist
  if (blacklist) cloud.blacklist = blacklist
  cloudFresh = gotSomething
  if (gotSomething) await writeCloudCache()
  licenseActions.setInfo({ cloudOnline: cloudFresh })
  // 拉完立刻按新数据重算一次状态（撤权/续期/封禁都要马上体现）
  await applyEvaluate()
  return cloudFresh
}

/* --------------------------- 时间与封禁 --------------------------- */

/** 记录历史最大系统时间：用户把时间调回过去时能被发现 */
const touchMaxSeen = async(): Promise<number> => {
  const now = Date.now()
  const stored = await getData<number>(KEY_MAX_SEEN) ?? 0
  const maxSeen = Math.max(now, stored, licenseState.maxSeenTime)
  if (maxSeen !== stored) await saveData(KEY_MAX_SEEN, maxSeen)
  licenseActions.setInfo({ maxSeenTime: maxSeen })
  return maxSeen
}

/** 本机条目是否被封禁：云端命中就本地留痕（断网也拦） */
const resolveBanned = async(): Promise<boolean> => {
  if (!entryCodeKey) return false
  if (cloudFresh) {
    const keys = cloud.blacklist?.keys ?? []
    if (keys.includes(entryCodeKey)) await saveData(KEY_BANNED, entryCodeKey)
    else if (await getData<string>(KEY_BANNED) === entryCodeKey) await removeData(KEY_BANNED)
  }
  return (await getData<string>(KEY_BANNED)) === entryCodeKey
}

/**
 * QQ 是否被封禁：换设备也拦（设备条目键变了，QQ 键不变）。
 * 和条目键一样：云端命中就本地留痕，断网照样拦。
 */
const isQQBanned = async(qqKeyValue: string): Promise<boolean> => {
  if (!qqKeyValue) return false
  if (cloudFresh) {
    const qkeys = cloud.blacklist?.qkeys ?? []
    if (qkeys.includes(qqKeyValue)) await saveData(KEY_BANNED_QQ, qqKeyValue)
    else if (await getData<string>(KEY_BANNED_QQ) === qqKeyValue) await removeData(KEY_BANNED_QQ)
  }
  return (await getData<string>(KEY_BANNED_QQ)) === qqKeyValue
}

/** 给 UI/管理端用：算 QQ 的条目键 */
export const qqKeyOf = async(qq: string): Promise<string> => {
  const normalized = normalizeCode(qq)
  if (!normalized) return ''
  try {
    return await authzNative.getQqKey(normalized)
  } catch (error) {
    console.warn('[authz] getQqKey failed:', errText(error))
    return ''
  }
}

/* --------------------------- 状态机 --------------------------- */

const applyEvaluate = async(): Promise<EvaluateResult> => {
  const maxSeen = await touchMaxSeen()
  const clockSkew = maxSeen - Date.now() > AUTHZ_CLOCK_TOLERANCE
  const entry = findEntry(cloud.whitelist?.devices ?? [], entryCodeKey)
  const banned = await resolveBanned()
  const qqBanned = await isQQBanned(memoryToken?.qqKey ?? '')

  const result = evaluate({
    nativeOk,
    biometricOk,
    biometricMessage,
    hasToken: tokenExists,
    token: memoryToken,
    entry,
    entryPending: entry?.status === 'pending',
    tokenHasQQ,
    cloudFresh,
    banned,
    qqBanned,
    clockSkew,
  })

  if (result.status !== 'active') memoryToken = null

  licenseActions.setInfo({
    deviceCode,
    status: result.status,
    message: result.message,
    exp: result.exp,
    daysLeft: result.daysLeft,
    hasToken: tokenExists,
    boundQQ: memoryToken?.qqMask ?? '',
    biometricAvailable: biometricOk,
    maxSeenTime: maxSeen,
    cloudOnline: cloudFresh,
  })

  return result
}

let gateShown = false

/** 失效时把全屏授权页推上来；已经在授权页就不重复推 */
const pushGateIfBlocked = () => {
  if (isUsableStatus(licenseState.status)) {
    gateShown = false
    return
  }
  if (gateShown) return
  gateShown = true
  void navigations.pushLicenseGate().catch(() => { gateShown = false })
}

/* --------------------------- 对外：设备码 --------------------------- */

export const getDeviceCode = async(): Promise<string> => {
  if (deviceCode) return deviceCode
  try {
    deviceCode = await authzNative.getDeviceCode()
  } catch (error) {
    console.warn('[authz] getDeviceCode failed:', errText(error))
    return ''
  }
  licenseActions.setInfo({ deviceCode })
  return deviceCode
}

/** 本机条目键（白名单比对用；管理端也用同一套算法） */
const getEntryKey = async(): Promise<string> => {
  if (entryCodeKey) return entryCodeKey
  const code = await getDeviceCode()
  if (!code) return ''
  try {
    entryCodeKey = await authzNative.getEntryKey(code)
  } catch (error) {
    console.warn('[authz] getEntryKey failed:', errText(error))
    return ''
  }
  return entryCodeKey
}

/* --------------------------- 初始化 / 守护 --------------------------- */

export const initLicense = async(): Promise<void> => {
  if (inited) {
    await applyEvaluate()
    return
  }
  inited = true

  // 1. 授权核自检：C++ 那边的向量算不对就别放行（会明确告诉用户）
  try {
    const selfTest = await authzNative.authzSelfTest()
    nativeOk = !selfTest
    if (!nativeOk) console.warn('[authz] native self-test failed:', selfTest)
  } catch (error) {
    nativeOk = false
    console.warn('[authz] native module unavailable:', errText(error))
  }

  // 2. 指纹状态
  try {
    const biometric = await authzNative.getBiometricState()
    biometricOk = !!biometric.available
    biometricMessage = biometric.message || ''
  } catch (error) {
    biometricOk = false
    biometricMessage = errText(error)
  }

  // 3. 设备身份 + 本机令牌
  await getDeviceCode()
  await getEntryKey()
  tokenExists = await authzNative.hasToken().catch(() => false)
  tokenHasQQ = (await getData<boolean>(KEY_TOKEN_HAS_QQ).catch(() => false)) === true
  memoryToken = null

  // 4. 先用缓存出状态（不等网络），后台再拉云端
  await readCloudCache()
  await applyEvaluate()
  void syncCloud().then(() => { pushGateIfBlocked() })
}

/** 重新检查指纹硬件/录入状态（用户去系统设置录完指纹回来点一下） */
export const recheckBiometric = async(): Promise<{ ok: boolean, message: string }> => {
  try {
    const biometric = await authzNative.getBiometricState()
    biometricOk = !!biometric.available
    biometricMessage = biometric.message || ''
  } catch (error) {
    biometricOk = false
    biometricMessage = errText(error)
  }
  const result = await applyEvaluate()
  if (!biometricOk) return { ok: false, message: biometricMessage || '仍然没有可用的指纹' }
  if (result.status === 'ready') return { ok: true, message: '指纹已就绪，去绑定本机授权' }
  if (result.status === 'locked') return { ok: true, message: '指纹已就绪，可以进入' }
  return { ok: true, message: result.message }
}

/** 复检本地状态（到期 / 时间回拨 / 封禁 / 锁屏掉授权） */
export const refreshLicense = async(): Promise<void> => {
  await applyEvaluate()
  pushGateIfBlocked()
}

/** 启动看门狗：定时复检 + 回前台复检 + 云端定期复查 + 锁屏熔断 */
export const startLicenseWatcher = () => {
  if (watcherStarted) return
  watcherStarted = true

  if (!screenOffBound) {
    screenOffBound = true
    authzNative.onScreenOff(() => {
      // 锁屏即熔断：内存令牌清空，回来必须重新验指纹
      memoryToken = null
      void applyEvaluate().then(pushGateIfBlocked)
    })
  }

  const tick = () => { void refreshLicense() }
  tick()
  setInterval(tick, 60 * 1000)
  AppState.addEventListener('change', (next) => { if (next === 'active') tick() })
  setInterval(() => { void syncCloud().then(pushGateIfBlocked) }, AUTHZ_REFRESH_INTERVAL)
}

/* --------------------------- 指纹：解锁 / 绑定 --------------------------- */

const messageForBind = (exp: string | null) => {
  if (!exp) return '绑定成功 · 永久有效'
  const days = daysLeftOf(exp) ?? 0
  return `绑定成功 · 剩余 ${Math.max(days, 1)} 天`
}

/**
 * 把一份授权绑到本机（会弹指纹；令牌用 Keystore 加密）。
 *
 * QQ 是**必填**的：设备码只认机器，绑了 QQ 才知道这机器是谁的；
 * 管理端也能直接按 QQ 封禁（换设备同样拦得住）。
 */
const bindToken = async(exp: string | null, via: BindVia, qq: string): Promise<{ ok: boolean, message: string }> => {
  if (!nativeOk) return { ok: false, message: '授权模块不可用，请更新到最新版本' }
  if (!biometricOk) return { ok: false, message: biometricMessage || '本机没有可用的指纹，请先去系统设置录入' }
  if (!entryCodeKey) return { ok: false, message: '设备码还没准备好，请稍后重试' }

  const normalizedQQ = String(qq ?? '').replace(/[^0-9]/g, '')
  if (!isValidQQ(normalizedQQ)) return { ok: false, message: '请填写有效的 QQ 号（5~12 位数字）' }
  const qk = await qqKeyOf(normalizedQQ)
  if (!qk) return { ok: false, message: 'QQ 校验没算出来，请更新到最新版本' }
  if (await isQQBanned(qk)) return { ok: false, message: '这个 QQ 已被封禁，无法绑定' }

  const token: AuthzToken = {
    v: 1,
    k: entryCodeKey,
    exp: exp ?? null,
    code: normalizeCode(deviceCode),
    bound: new Date().toISOString(),
    via,
    qqMask: maskQQ(normalizedQQ),
    qqKey: qk,
  }
  try {
    await authzNative.storeToken(encodeToken(token))
  } catch (error) {
    return { ok: false, message: errText(error) }
  }
  tokenExists = true
  tokenHasQQ = true
  await saveData(KEY_TOKEN_HAS_QQ, true).catch(() => {})
  memoryToken = token
  await applyEvaluate()
  return { ok: true, message: messageForBind(exp) }
}

/** 已绑定过本机：验指纹解锁进入 */
export const unlockWithFingerprint = async(): Promise<{ ok: boolean, message: string }> => {
  if (!nativeOk) return { ok: false, message: '授权模块不可用，请更新到最新版本' }
  if (!biometricOk) return { ok: false, message: biometricMessage || '本机没有可用的指纹' }

  let raw: string
  try {
    raw = await authzNative.readToken()
  } catch (error) {
    await applyEvaluate()
    return { ok: false, message: errText(error) }
  }

  const token = decodeToken(raw)
  if (!token) {
    await clearLocalLicense()
    return { ok: false, message: '本机授权数据已损坏，请重新绑定' }
  }
  if (token.k !== entryCodeKey) {
    await clearLocalLicense()
    return { ok: false, message: '这份授权不属于本机，请重新绑定' }
  }
  if (isExpired(token.exp)) {
    memoryToken = null
    await applyEvaluate()
    return { ok: false, message: '授权已到期，请联系管理员续期' }
  }

  if (token.qqKey) {
    tokenHasQQ = true
    await saveData(KEY_TOKEN_HAS_QQ, true).catch(() => {})
  }
  memoryToken = token
  // 顺手把云端变更（续期/改期）同步一下，让状态机决定要不要重新绑定
  void syncCloud()
  const result = await applyEvaluate()
  if (result.status === 'ready') {
    return { ok: false, message: '授权信息有变更，请点「绑定本机指纹」完成同步' }
  }
  if (result.status !== 'active') return { ok: false, message: result.message }
  return { ok: true, message: messageForBind(token.exp) }
}

/** 只拉云端状态（不弹指纹）：给「刷新」按钮用 */
export const refreshAuthorization = async(): Promise<{ ok: boolean, message: string }> => {
  const fresh = await syncCloud()
  await applyEvaluate()
  if (!fresh) return { ok: false, message: '暂时连不上云端，请检查网络后再试' }
  const entry = findEntry(cloud.whitelist?.devices ?? [], entryCodeKey)
  if (!entry) return { ok: false, message: '云端名单里还没有这台设备，请把设备码发给管理员' }
  if (isExpired(entry.exp)) return { ok: false, message: '这台设备的授权已到期，请联系管理员续期' }
  return { ok: true, message: tokenExists ? '已授权，验证指纹后进入' : '管理员已授权，去绑定本机指纹' }
}

/** 白名单已授权：绑指纹（首次绑定 / 续期后重新绑定） */
export const bindByWhitelist = async(qq: string): Promise<{ ok: boolean, message: string }> => {
  if (!cloudFresh) await syncCloud()
  const entry = findEntry(cloud.whitelist?.devices ?? [], entryCodeKey)
  if (!entry) {
    await applyEvaluate()
    return { ok: false, message: '云端名单里还没有这台设备，请把设备码发给管理员' }
  }
  if (isExpired(entry.exp)) {
    await applyEvaluate()
    return { ok: false, message: '这台设备的授权已到期，请联系管理员续期' }
  }
  // 管理员开通时如果已经填了 QQ，这里必须对得上（防止把别人的授权挪到自己机器上）
  const normalizedQQ = String(qq ?? '').replace(/[^0-9]/g, '')
  if (entry.qk && isValidQQ(normalizedQQ)) {
    const qk = await qqKeyOf(normalizedQQ)
    if (qk && qk !== entry.qk) {
      await applyEvaluate()
      return { ok: false, message: '这台设备的授权绑定的是另一个 QQ，请联系管理员核对' }
    }
  }
  return bindToken(entry.exp ?? null, 'whitelist', normalizedQQ)
}

/* --------------------------- 换机 / 离线授权 --------------------------- */

const applyMigration = async(code: string, qq: string): Promise<{ ok: boolean, message: string }> => {
  let result: { expMs: number, issuedSec: number, srcTag: string, nonce: number }
  try {
    result = await authzNative.importMigration(code)
  } catch (error) {
    return { ok: false, message: errText(error) }
  }

  const marker = `${result.issuedSec}:${result.nonce}`
  const used = await getData<string[]>(KEY_USED_MIGRATIONS) ?? []
  if (Array.isArray(used) && used.includes(marker)) {
    return { ok: false, message: '这个迁移码本机已经用过了，请让老设备重新导出' }
  }

  const exp = result.expMs > 0 ? new Date(result.expMs).toISOString() : null
  const bound = await bindToken(exp, 'migration', qq)
  if (bound.ok) {
    await saveData(KEY_USED_MIGRATIONS, [...used, marker].slice(-AUTHZ_USED_MIGRATION_LIMIT))
  }
  return bound
}

const applyOfflineAuth = async(code: string, qq: string): Promise<{ ok: boolean, message: string }> => {
  const packed = unpackOfflineAuth(code)
  if (!packed) return { ok: false, message: '离线授权串格式不正确' }
  const payload = buildOfflineAuthPayload(deviceCode, packed.expToken)
  if (!rsaVerify(LICENSE_PUBLIC_KEY, payload, packed.signatureHex)) {
    return { ok: false, message: '离线授权串无效，或不是签发给本机的' }
  }
  const exp = fromExpToken(packed.expToken)
  if (isExpired(exp)) return { ok: false, message: '这张离线授权已经过期' }
  return bindToken(exp, 'offline', qq)
}

/** 粘贴框统一入口：自动分辨迁移码 / 离线授权串（都要带 QQ） */
export const applyAuthString = async(raw: string, qq: string): Promise<{ ok: boolean, message: string }> => {
  const text = String(raw ?? '').replace(/\s/g, '').trim()
  if (!text) return { ok: false, message: '请粘贴迁移码或离线授权串' }
  if (!nativeOk) return { ok: false, message: '授权模块不可用，请更新到最新版本' }
  if (!isValidQQ(String(qq ?? '').replace(/[^0-9]/g, ''))) return { ok: false, message: '请先填写有效的 QQ 号（5~12 位数字）' }
  if (text.toUpperCase().startsWith(MIGRATION_PREFIX)) return applyMigration(text, qq)
  return applyOfflineAuth(text, qq)
}

/**
 * 生成「授权申请码」：客户端没有云端写权限，所以把 QQ + 设备码打包成一段可复制的串，
 * 用户发给管理员；管理端粘贴后校验 HMAC、看头像/昵称，再决定通过或待审核。
 */
export const buildRequestCode = async(qq: string, nickname: string): Promise<{ ok: boolean, message: string, code?: string }> => {
  const normalized = normalizeCode(qq)
  if (!isValidQQ(normalized)) return { ok: false, message: '请填写有效的 QQ 号（5~12 位数字）' }
  if (!nativeOk) return { ok: false, message: '授权核不可用，请更新到最新版本' }
  await getDeviceCode()
  if (!deviceCode) return { ok: false, message: '设备码还没准备好，请稍后重试' }

  try {
    // 申请码 = YQR1.<hex(JSON)>.<HMAC 前 32 位>，HMAC 用授权核里的密钥，复制过程被改动立刻能发现
    const request = {
      v: 1 as const,
      qq: normalized,
      nick: String(nickname ?? '').slice(0, 40),
      code: normalizeCode(deviceCode),
      ts: Math.floor(Date.now() / 1000),
    }
    const bodyHex = utf8ToHex(JSON.stringify(request))
    const mac = await authzNative.signText(bodyHex)
    const code = packRequest(request, mac)
    return { ok: true, message: '申请码已生成，发给管理员即可', code }
  } catch (error) {
    return { ok: false, message: errText(error) }
  }
}

/** 老设备导出迁移码（必须先验过指纹） */
export const exportMigrationCode = async(): Promise<{ ok: boolean, message: string, code?: string }> => {
  if (!nativeOk) return { ok: false, message: '授权模块不可用，请更新到最新版本' }
  if (!memoryToken) return { ok: false, message: '请先验证指纹进入，再导出迁移码' }
  const expMs = memoryToken.exp ? Date.parse(memoryToken.exp) : 0
  try {
    const code = await authzNative.exportMigration(Number.isNaN(expMs) ? 0 : expMs)
    return { ok: true, message: '迁移码 24 小时内有效，用一次即失效', code }
  } catch (error) {
    return { ok: false, message: errText(error) }
  }
}

/** 当前本机绑定的 QQ（掩码），没解锁时为空 */
export const getBoundQQ = (): string => memoryToken?.qqMask ?? ''

/** 解除本机绑定（换机后老设备用；云端条目请让管理员删） */
export const clearLocalLicense = async(): Promise<void> => {
  memoryToken = null
  tokenExists = false
  tokenHasQQ = false
  await removeData(KEY_TOKEN_HAS_QQ).catch(() => {})
  try {
    await authzNative.clearToken()
  } catch (error) {
    console.warn('[authz] clearToken failed:', errText(error))
  }
  await applyEvaluate()
}

/** 手动锁定：下次进入必须重新验指纹 */
export const lockNow = async(): Promise<void> => {
  memoryToken = null
  await applyEvaluate()
}
