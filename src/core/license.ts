// 授权校验（纯离线）：客户端只内置公钥/校验密钥，卡密由管理端签发
import { AppState } from 'react-native'
import { getData, saveData, removeData } from '@/plugins/storage'
import licenseActions from '@/store/license/action'
import licenseState, { type LicenseRecord } from '@/store/license/state'
import { sha256, randomHex } from '@/utils/sha256'
import { verifyCardKey } from '@/utils/licenseCard'
import { LICENSE_PUBLIC_KEY } from '@/config/licenseKey'
import { BLACKLIST_SOURCES } from '@/config/blacklist'
import { navigations } from '@/navigation'

const KEY_DEVICE = 'license.deviceCode'
const KEY_RECORD = 'license.record'
const KEY_MAX_SEEN = 'license.maxSeenTime'
// 本机黑名单：直接生效、不依赖网络
const KEY_LOCAL_BAN = 'license.localBlacklist'
// 云端黑名单缓存：拉取成功后落盘，断网/超时也能用
const KEY_CLOUD_CACHE = 'license.cloudBlacklist'

/** 允许的时钟回拨容差：10 分钟（防止 NTP 校正误判） */
const CLOCK_TOLERANCE = 10 * 60 * 1000
/** 云端黑名单单个源的超时 */
const CLOUD_FETCH_TIMEOUT = 3000
/** 激活时等待云端黑名单的上限（超时直接跳过，绝不卡住） */
const CLOUD_CHECK_TIMEOUT = 3500

const formatCode = (raw: string) => {
  const up = raw.toUpperCase()
  const groups: string[] = []
  for (let i = 0; i < up.length; i += 4) groups.push(up.slice(i, i + 4))
  return groups.join('-')
}

const withTimeout = <T>(promise: Promise<T>, ms: number, tip = 'timeout'): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error(tip)) }, ms)
  promise.then(
    (value) => { clearTimeout(timer); resolve(value) },
    (err) => { clearTimeout(timer); reject(err) },
  )
})

/** 卡密哈希（黑名单只存哈希，不存明文） */
export const cardHashOf = (card: string) => sha256('yieyu-card:' + String(card || '').replace(/\s/g, '').toUpperCase())

/** 设备码：首次运行时本地随机生成并持久化（不发上网） */
export const getDeviceCode = async(): Promise<string> => {
  if (licenseState.deviceCode) return licenseState.deviceCode
  let raw = await getData<string>(KEY_DEVICE)
  if (!raw) {
    raw = randomHex(32)
    await saveData(KEY_DEVICE, raw)
  }
  const code = formatCode(sha256(raw).slice(0, 16))
  licenseActions.setInfo({ deviceCode: code })
  return code
}

/* ------------------------ 黑名单：本机（立即生效）+ 云端（可选） ------------------------ */

const readLocalBan = async(): Promise<string[]> => {
  const list = await getData<string[]>(KEY_LOCAL_BAN)
  return Array.isArray(list) ? list : []
}

const writeLocalBan = async(list: string[]) => {
  await saveData(KEY_LOCAL_BAN, list.slice(-2000))
}

export const isBannedLocally = async(hash: string): Promise<boolean> => {
  if (!hash) return false
  return (await readLocalBan()).includes(hash)
}

/** 云端黑名单：多源并发 + 超时，取 updatedAt 最新的一份（各镜像缓存时间不同） */
const fetchCloudBlacklist = async(): Promise<CloudResult | null> => {
  const one = async(source: { url: string, headers?: Record<string, string> }): Promise<CloudResult> => {
    const url = source.url + (source.url.includes('?') ? '&' : '?') + 't=' + Date.now()
    const res = await withTimeout(fetch(url, { headers: { 'User-Agent': 'Yieyu-music', ...(source.headers || {}) } }), CLOUD_FETCH_TIMEOUT)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await withTimeout(res.json() as Promise<{ keys?: string[], updatedAt?: string }>, CLOUD_FETCH_TIMEOUT)
    if (!Array.isArray(data.keys)) throw new Error('bad data')
    const parsed = Date.parse(String(data.updatedAt ?? ''))
    return {
      keys: data.keys.map(key => String(key).toLowerCase()),
      updatedAt: Number.isNaN(parsed) ? 0 : parsed,
    }
  }
  const tasks = BLACKLIST_SOURCES.map(source => one(source).catch(() => null))
  const all = await Promise.all(tasks)
  let best: CloudResult | null = null
  for (const item of all) {
    if (!item) continue
    if (!best || item.updatedAt > best.updatedAt) best = item
  }
  return best
}

const loadCloudBlacklist = async(): Promise<{ keys: string[], fromCache: boolean, checkedAt: number }> => {
  const cached = await getData<{ keys: string[], at: number }>(KEY_CLOUD_CACHE)
  try {
    const result = await withTimeout(fetchCloudBlacklist(), CLOUD_CHECK_TIMEOUT)
    if (result) {
      await saveData(KEY_CLOUD_CACHE, { keys: result.keys, at: Date.now() })
      return { keys: result.keys, fromCache: false, checkedAt: Date.now() }
    }
  } catch {}
  if (cached && Array.isArray(cached.keys)) return { keys: cached.keys, fromCache: true, checkedAt: cached.at ?? 0 }
  return { keys: [], fromCache: true, checkedAt: 0 }
}

/* ------------------------ 时间与状态 ------------------------ */

/** 记录历史最大系统时间：用户把系统时间调回过去时可被发现 */
const touchMaxSeen = async(): Promise<number> => {
  const now = Date.now()
  const stored = await getData<number>(KEY_MAX_SEEN) ?? 0
  const maxSeen = Math.max(now, stored, licenseState.maxSeenTime)
  if (maxSeen !== stored) await saveData(KEY_MAX_SEEN, maxSeen)
  licenseActions.setInfo({ maxSeenTime: maxSeen })
  return maxSeen
}

const daysBetween = (target: number) => Math.ceil((target - Date.now()) / 86400000)

/** 核心校验：到期时间 + 时间回拨检测 */
const evaluate = (record: LicenseRecord | null, maxSeen: number) => {
  if (!record) {
    // 因为封禁而被收回的授权：保持「已被封禁」，直到重新激活成功
    if (licenseState.status === 'banned') {
      licenseActions.setInfo({ record: null, status: 'banned', message: '此卡密已被封禁', daysLeft: null })
      return
    }
    licenseActions.setInfo({ record: null, status: 'none', message: '未激活', daysLeft: null })
    return
  }
  const now = Date.now()
  // 系统时间被调回过去（超过容差）→ 直接失效
  if (maxSeen - now > CLOCK_TOLERANCE) {
    licenseActions.setInfo({
      record,
      status: 'tampered',
      message: '检测到系统时间异常，请校准系统时间后重试',
      daysLeft: null,
    })
    return
  }
  if (record.expiresAt) {
    const expires = Date.parse(record.expiresAt)
    if (now > expires) {
      licenseActions.setInfo({ record, status: 'expired', message: '您的授权已到期，请联系管理员', daysLeft: 0 })
      return
    }
    licenseActions.setInfo({
      record,
      status: 'active',
      message: `VIP 已激活，剩余 ${daysBetween(expires)} 天`,
      daysLeft: daysBetween(expires),
    })
    return
  }
  licenseActions.setInfo({ record, status: 'active', message: 'VIP 已激活，永久有效', daysLeft: null })
}

const readRecord = async() => licenseState.record ?? await getData<LicenseRecord>(KEY_RECORD)

/* ------------------------ 激活 ------------------------ */

/** 输入卡密激活：验签 + 设备码匹配 + 到期校验 + 黑名单 */
export const activateLicense = async(cardKey: string): Promise<{ ok: boolean, message: string }> => {
  const raw = String(cardKey || '').trim()
  if (!raw) return { ok: false, message: '请输入卡密' }
  const hash = cardHashOf(raw)

  // 1. 本机黑名单：毫秒级，直接拒绝
  if (await isBannedLocally(hash)) return { ok: false, message: '此卡密已被封禁' }

  // 2. 离线验签（失败立刻返回，不会卡）
  const deviceCode = await getDeviceCode()
  let result: { expiresAt: string | null }
  try {
    result = verifyCardKey(LICENSE_PUBLIC_KEY, raw, deviceCode)
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }

  // 3. 云端黑名单（可选，最多 3.5 秒；拉不到就用缓存/直接放行）
  const cloud = await loadCloudBlacklist()
  if (cloud.keys.includes(hash)) {
    await writeLocalBan([...await readLocalBan(), hash])
    return { ok: false, message: '此卡密已被封禁' }
  }

  // 4. 写入授权记录
  const compact = raw.replace(/\s/g, '')
  const record: LicenseRecord = {
    cardHash: hash,
    // 16 位短卡密直接完整显示，旧版长卡密做脱敏
    cardMasked: compact.length > 24 ? `${compact.slice(0, 10)}…${compact.slice(-6)}` : compact,
    expiresAt: result.expiresAt,
    activatedAt: new Date().toISOString(),
  }
  await saveData(KEY_RECORD, record)
  const maxSeen = await touchMaxSeen()
  evaluate(record, maxSeen)

  const days = record.expiresAt ? daysBetween(Date.parse(record.expiresAt)) : 0
  return {
    ok: true,
    message: record.expiresAt ? `激活成功，VIP 剩余 ${Math.max(days, 1)} 天` : '激活成功，永久有效',
  }
}

/** 重新校验本地授权（到期 / 时间回拨 / 被封禁） */
export const refreshLicense = async(): Promise<void> => {
  const maxSeen = await touchMaxSeen()
  const record = await readRecord()
  if (record?.cardHash && await isBannedLocally(record.cardHash)) {
    await removeData(KEY_RECORD)
    licenseActions.setInfo({ record: null, status: 'banned', message: '此卡密已被封禁', daysLeft: null })
    return
  }
  evaluate(record, maxSeen)
}

/** 应用启动时初始化 */
export const initLicense = async(): Promise<void> => {
  await getDeviceCode()
  const maxSeen = await touchMaxSeen()
  evaluate(await readRecord(), maxSeen)
  // 后台静默同步一次云端黑名单（不阻塞启动）
  void loadCloudBlacklist().catch(() => {})
}

export const clearLicense = async(): Promise<void> => {
  await removeData(KEY_RECORD)
  evaluate(null, licenseState.maxSeenTime)
}

/* ------------------------- 运行期看门狗：失效立刻弹回拦截页 ------------------------- */

let watcherStarted = false
let lastBlocked = false

const enforceGate = () => {
  const blocked = licenseState.status !== 'active'
  if (!blocked) {
    lastBlocked = false
    return
  }
  if (lastBlocked) return
  lastBlocked = true
  void navigations.pushLicenseGate().catch(() => {})
}

/** 启动看门狗：定时复检 + 回到前台复检 + 失效立即切回全屏拦截页 */
export const startLicenseWatcher = () => {
  if (watcherStarted) return
  watcherStarted = true
  const tick = () => { void refreshLicense().finally(enforceGate) }
  tick()
  setInterval(tick, 60 * 1000)
  AppState.addEventListener('change', (next) => {
    if (next === 'active') tick()
  })
}
