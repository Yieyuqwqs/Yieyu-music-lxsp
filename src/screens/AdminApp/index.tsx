import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Image, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { getSecret, setSecret } from '@/utils/nativeModules/secureStore'

import { sha256 } from '@/utils/sha256'
import { rsaSign, rsaVerify } from '@/utils/rsa'
import authzNative from '@/utils/nativeModules/authz'
import {
  buildOfflineAuthPayload, isValidQQ, maskQQ, normalizeCode, packOfflineAuth, toExpToken, unpackRequest,
} from '@/core/authz/protocol'
import { avatarUrlOf } from '@/utils/qqProfile'
import { AUTHZ_BLACKLIST_FILE, AUTHZ_OWNER, AUTHZ_REPO, AUTHZ_WHITELIST_FILE, AUTHZ_BRANCH } from '@/config/authz'
import { LICENSE_PUBLIC_KEY } from '@/config/licenseKey'
// 私钥由 CI 注入（scripts/write-admin-key.js）；仓库里只有 DEV 占位，签出来的串客户端验不过
import { LICENSE_PRIVATE_KEY } from './signing'

const OWNER = AUTHZ_OWNER
const REPO = AUTHZ_REPO
const BRANCH = AUTHZ_BRANCH
const WHITELIST_FILE = AUTHZ_WHITELIST_FILE
const BLACKLIST_FILE = AUTHZ_BLACKLIST_FILE
const TOKEN_STORE_KEY = 'yieyu.admin.token'
const SESSION_STORE_KEY = 'yieyu.admin.session'

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error('网络超时')) }, ms)
  promise.then(
    (value) => { clearTimeout(timer); resolve(value) },
    (err) => { clearTimeout(timer); reject(err) },
  )
})

const ghFetch = async(token: string, path: string, init?: any) => withTimeout(fetch('https://api.github.com' + path, {
  ...init,
  headers: {
    Authorization: 'token ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Yieyu-Admin',
    ...(init && init.body ? { 'Content-Type': 'application/json' } : {}),
  },
}), 12000)

// 管理员口令的 sha256（源码里看不到明文）
// 当前口令：ts1cf5@.  （结尾有一个点）
const ADMIN_PASSWORD_HASH = '848cf308f3e9144dac507c141686ccc3adedaceb734390875bdac67057e9d94c'
const LEGACY_PASSWORD_HASHES = [
  'ee005e159819254a99c2b1587aae9c5405a34b5312879c639f0a44fba1327344',
]

const normalizePassword = (raw: string) => String(raw ?? '')
  .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  .replace(/\s+/g, '')
  .replace(/[\u200B-\u200D\uFEFF]/g, '')
  .replace(/[\u3002\uFF61]/g, '.')
  .trim()

const checkPassword = (raw: string): { ok: boolean, hash: string } => {
  const normalized = normalizePassword(raw)
  if (!normalized) return { ok: false, hash: '' }
  const allowed = [ADMIN_PASSWORD_HASH, ...LEGACY_PASSWORD_HASHES]
  if (allowed.includes(sha256(normalized))) return { ok: true, hash: sha256(normalized) }
  return { ok: false, hash: sha256(normalized) }
}

const VALIDITY_OPTIONS = [
  { label: '1 天', days: 1 },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
  { label: '365 天', days: 365 },
  { label: '永久', days: 0 },
]

interface WhitelistEntry {
  k: string
  exp: string | null
  at?: string
  qq?: string
  qk?: string
  nick?: string
  status?: 'pending' | 'approved'
}

const maskKey = (key: string) => key.slice(0, 10) + '…' + key.slice(-4)

const AdminApp = memo(() => {
  const [booted, setBooted] = useState(false)
  const [unlocked, setUnlocked] = useState(false)
  const [password, setPassword] = useState('')
  const [showPwd, setShowPwd] = useState(false)
  const [loginError, setLoginError] = useState('')

  const [deviceCode, setDeviceCode] = useState('')
  const [days, setDays] = useState(30)
  const [customMode, setCustomMode] = useState(false)
  const [customDays, setCustomDays] = useState('')
  const [busy, setBusy] = useState(false)
  const [tip, setTip] = useState('')
  const [offlineAuth, setOfflineAuth] = useState('')

  const [token, setToken] = useState('')
  const [tokenSaved, setTokenSaved] = useState(false)
  const [devices, setDevices] = useState<WhitelistEntry[]>([])
  const [banned, setBanned] = useState<string[]>([])
  const [qqInput, setQQInput] = useState('')
  const [bannedQQ, setBannedQQ] = useState<string[]>([])
  const [requestRaw, setRequestRaw] = useState('')
  const [request, setRequest] = useState<{ qq: string, nick: string, code: string, ts: number, bodyHex: string, macHex: string } | null>(null)
  const [requestBusy, setRequestBusy] = useState(false)
  const [listTip, setListTip] = useState('')

  // ---------------------------------------------------------------- 登录

  useEffect(() => {
    let alive = true
    void (async() => {
      try {
        // 老版本把 Token 明文存在 AsyncStorage：升级后立刻抹掉，别留一份明文在原地
        const legacy = await AsyncStorage.getItem(LEGACY_TOKEN_STORE_KEY).catch(() => null)
        if (legacy) await AsyncStorage.removeItem(LEGACY_TOKEN_STORE_KEY).catch(() => {})
        const [session, savedToken] = await Promise.all([
          AsyncStorage.getItem(SESSION_STORE_KEY),
          getSecret(TOKEN_STORE_KEY),
        ])
        if (!alive) return
        if (savedToken) { setToken(savedToken); setTokenSaved(true) }
        if (session === '1') setUnlocked(true)
      } catch {
        // 读不到就回退到登录页
      } finally {
        if (alive) setBooted(true)
      }
    })()
    return () => { alive = false }
  }, [])

  const handleLogin = useCallback(() => {
    const result = checkPassword(password)
    if (result.ok) {
      setUnlocked(true)
      setLoginError('')
      setPassword('')
      AsyncStorage.setItem(SESSION_STORE_KEY, '1').catch(() => {})
    } else {
      setLoginError(password.trim()
        ? `口令不正确（校验 ${result.hash.slice(0, 8)}…）`
        : '请输入口令')
    }
  }, [password])

  const handleLogout = useCallback(() => {
    Alert.alert('退出登录', '下次打开需要重新输入口令。', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: () => {
          setUnlocked(false)
          setOfflineAuth('')
          setTip('')
          AsyncStorage.removeItem(SESSION_STORE_KEY).catch(() => {})
        },
      },
    ])
  }, [])

  // ---------------------------------------------------------------- 云端文件

  const persistToken = useCallback(async() => {
    const result = await setSecret(TOKEN_STORE_KEY, token.trim())
    setTokenSaved(true)
    if (result.persisted) {
      Alert.alert('已保存', 'Token 已用系统 Keystore 硬件加密保存，不会写进 APK、也不再是明文。')
    } else {
      Alert.alert('只在本机内存生效', `${result.reason ?? '硬件加密不可用'}\n\n关闭应用后需要重新粘贴 Token。`)
    }
  }, [token])

  /**
   * 读云端文件（带内存缓存）。
   *
   * 管理端一次操作本来要 GET + PUT 两趟，每次往返 1~9 秒（国内直连 api.github.com 就这速度）。
   * 缓存 sha 之后，连续操作只要 PUT 一趟；写成功也会把新 sha 写回缓存。
   */
  const fileCache = useRef<Record<string, { sha: string, json: any, at: number }>>({})

  const loadFile = useCallback(async(file: string, force = false): Promise<{ json: any, sha: string } | null> => {
    if (!token) throw new Error('请先保存 GitHub Token')
    const cached = fileCache.current[file]
    if (!force && cached && Date.now() - cached.at < 60000) return { json: cached.json, sha: cached.sha }

    let lastError: any = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ghFetch(token, `/repos/${OWNER}/${REPO}/contents/${file}?ref=${BRANCH}`)
        if (res.status === 404) { delete fileCache.current[file]; return null }
        if (!res.ok) throw new Error('读取 ' + file + ' 失败：HTTP ' + res.status)
        const data = await res.json()
        const text = Buffer.from(String(data.content ?? '').replace(/\s/g, ''), 'base64').toString('utf8')
        const json = JSON.parse(text)
        fileCache.current[file] = { sha: data.sha as string, json, at: Date.now() }
        return { json, sha: data.sha as string }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('读取 ' + file + ' 失败')
  }, [token])

  /**
   * 写云端文件。
   *
   * GitHub 的 contents API 要求带上文件的 sha；如果这中间文件被别人（或自己另一次操作）改过，
   * 就会回 409 "does not match <sha>"。这里遇到 409 就重新读一次 sha 再写，最多 3 轮。
   */
  const writeFile = useCallback(async(file: string, payload: any, sha: string | null, message: string) => {
    if (!token) throw new Error('请先保存 GitHub Token')
    const content = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8').toString('base64')

    let currentSha = sha
    let lastError = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      const body: any = { message, content, branch: BRANCH }
      if (currentSha) body.sha = currentSha
      const res = await ghFetch(token, `/repos/${OWNER}/${REPO}/contents/${file}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data = await res.json().catch(() => null)
        fileCache.current[file] = { sha: String(data?.content?.sha ?? ''), json: payload, at: Date.now() }
        return
      }
      const text = await res.text()
      lastError = 'HTTP ' + res.status + ' ' + text.slice(0, 120)
      // 409 = sha 过期；404 = 文件不存在（下次不带 sha 新建）
      if (res.status !== 409 && res.status !== 404) break
      const fresh = await loadFile(file).catch(() => null)
      currentSha = fresh?.sha ?? null
      setTip(`云端文件刚被改过，正在重试（第 ${attempt}/3 次）…`)
    }
    throw new Error('写入 ' + file + ' 失败：' + lastError)
  }, [loadFile, token])

  const entryKeyOf = useCallback(async(code: string): Promise<string> => {
    const key = await authzNative.getEntryKey(normalizeCode(code))
    if (!key || key.length !== 64) throw new Error('授权核不可用（管理端包里缺 libyieyu_authz.so）')
    return key
  }, [])

  const qqKeyOf = useCallback(async(qq: string): Promise<string> => {
    const value = normalizeCode(qq)
    if (!isValidQQ(value)) throw new Error('QQ 号格式不对（5~12 位数字）')
    const key = await authzNative.getQqKey(value)
    if (!key || key.length !== 64) throw new Error('授权核不可用（管理端包里缺 libyieyu_authz.so）')
    return key
  }, [])

  const refreshLists = useCallback(async() => {
    if (!token) return
    setListTip('正在拉取云端名单…')
    try {
      const [white, black] = await Promise.all([
        loadFile(WHITELIST_FILE, true).catch(() => null),
        loadFile(BLACKLIST_FILE, true).catch(() => null),
      ])
      const whiteDevices = Array.isArray(white?.json?.devices) ? white!.json.devices as WhitelistEntry[] : []
      setDevices(whiteDevices.filter(item => item && typeof item.k === 'string'))
      setBanned(Array.isArray(black?.json?.keys) ? black!.json.keys as string[] : [])
      setBannedQQ(Array.isArray(black?.json?.qkeys) ? black!.json.qkeys as string[] : [])
      setListTip(`白名单 ${whiteDevices.length} 台 · 封禁设备 ${Array.isArray(black?.json?.keys) ? black!.json.keys.length : 0} 条 · 封禁 QQ ${Array.isArray(black?.json?.qkeys) ? black!.json.qkeys.length : 0} 个`)
    } catch (err: any) {
      setListTip('拉取失败：' + String(err?.message ?? err))
    }
  }, [loadFile, token])

  useEffect(() => {
    if (!unlocked || !token) return
    void refreshLists()
  }, [refreshLists, token, unlocked])

  // ---------------------------------------------------------------- 授权 / 撤权

  const effectiveDays = days === -1 ? Number(customDays) : days

  const validateInput = useCallback((): string | null => {
    const device = normalizeCode(deviceCode)
    if (!device) { Alert.alert('提示', '请先在下面「授权申请」里粘贴并解析用户的申请码（设备码会自动带出）'); return null }
    if (device.length < 16) { Alert.alert('提示', '设备码看起来不完整（应为 16 位，如 AB12-CD34-EF56-7890）'); return null }
    if (days === -1 && (!effectiveDays || effectiveDays <= 0)) { Alert.alert('提示', '请输入有效的天数'); return null }
    return device
  }, [days, deviceCode, effectiveDays])

  const handleAuthorize = useCallback(async() => {
    const device = validateInput()
    if (!device) return
    setBusy(true)
    setTip('正在写入白名单…')
    try {
      const key = await entryKeyOf(device)
      const current = await loadFile(WHITELIST_FILE)
      const list: WhitelistEntry[] = Array.isArray(current?.json?.devices)
        ? (current!.json.devices as WhitelistEntry[]).filter(item => item && item.k !== key)
        : []
      const exp = effectiveDays > 0 ? new Date(Date.now() + effectiveDays * 86400000).toISOString() : null
      const qqValue = normalizeCode(qqInput)
      // 设备码和 QQ 必须成对写入：以后按 QQ 认人/封禁全靠这条记录
      if (!isValidQQ(qqValue)) throw new Error('请填写用户 QQ 号（5~12 位数字），设备码要和 QQ 一起绑定')
      const entry: WhitelistEntry = {
        k: key,
        exp,
        at: new Date().toISOString(),
        qq: maskQQ(qqValue),
        qk: await qqKeyOf(qqValue),
        status: 'approved',
      }
      list.push(entry)
      await writeFile(WHITELIST_FILE, { version: 1, updatedAt: new Date().toISOString(), devices: list }, current?.sha ?? null,
        `authz: 开通 ${device.slice(0, 9)}…（${effectiveDays > 0 ? effectiveDays + ' 天' : '永久'}）`)
      setDevices(list)
      setTip(`已开通 ${device} · ${exp ? '至 ' + exp.slice(0, 10) : '永久'} · 条目 ${maskKey(key)}${entry.qq ? ' · QQ ' + entry.qq : ''}`)
      Alert.alert('已开通', '让用户在客户端点「刷新授权状态」，然后录入指纹即可。')
    } catch (err: any) {
      setTip('开通失败：' + String(err?.message ?? err))
      Alert.alert('开通失败', String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [entryKeyOf, effectiveDays, loadFile, qqInput, qqKeyOf, validateInput, writeFile])

  const removeDevice = useCallback(async(code: string) => {
    setBusy(true)
    setTip('正在移除…')
    try {
      const key = await entryKeyOf(code)
      const current = await loadFile(WHITELIST_FILE)
      const list: WhitelistEntry[] = Array.isArray(current?.json?.devices)
        ? (current!.json.devices as WhitelistEntry[]).filter(item => item && item.k !== key)
        : []
      await writeFile(WHITELIST_FILE, { version: 1, updatedAt: new Date().toISOString(), devices: list }, current?.sha ?? null,
        `authz: 移除 ${code.slice(0, 9)}…`)
      setDevices(list)
      setTip(`已移除 ${code}`)
    } catch (err: any) {
      setTip('移除失败：' + String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [entryKeyOf, loadFile, writeFile])

  /** 按 QQ 移除授权：白名单里所有 qk 匹配的条目一起删（一个 QQ 可能有多台设备） */
  const removeByQQ = useCallback(async() => {
    const qqValue = normalizeCode(qqInput)
    if (!isValidQQ(qqValue)) {
      Alert.alert('提示', '请先填写要移除授权的 QQ 号')
      return
    }
    setBusy(true)
    setTip('正在移除…')
    try {
      const qk = await qqKeyOf(qqValue)
      const current = await loadFile(WHITELIST_FILE)
      const list: WhitelistEntry[] = Array.isArray(current?.json?.devices)
        ? (current!.json.devices as WhitelistEntry[]).filter(item => item && item.qk !== qk)
        : []
      await writeFile(WHITELIST_FILE, { version: 1, updatedAt: new Date().toISOString(), devices: list }, current?.sha ?? null,
        `authz: 移除 QQ ${maskQQ(qqValue)} 的授权`)
      setDevices(list)
      setTip(`已移除 QQ ${maskQQ(qqValue)} 的授权`)
    } catch (err: any) {
      setTip('移除失败：' + String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [loadFile, qqInput, qqKeyOf, writeFile])

  const handleRemove = useCallback(() => {
    const qqValue = normalizeCode(qqInput)
    if (!isValidQQ(qqValue)) {
      Alert.alert('提示', '请先填写要移除授权的 QQ 号')
      return
    }
    Alert.alert('移除授权', `确定移除 QQ ${maskQQ(qqValue)} 这台设备的授权？`, [
      { text: '取消', style: 'cancel' },
      { text: '移除', style: 'destructive', onPress: () => { void removeByQQ() } },
    ])
  }, [qqInput, removeByQQ])

  // ---------------------------------------------------------------- 黑名单

  const setBannedState = useCallback(async(device: string, ban: boolean) => {
    setBusy(true)
    setTip(ban ? '正在封禁…' : '正在解封…')
    try {
      const key = await entryKeyOf(device)
      const current = await loadFile(BLACKLIST_FILE)
      const keys: string[] = Array.isArray(current?.json?.keys) ? current!.json.keys as string[] : []
      const next = ban
        ? (keys.includes(key) ? keys : [...keys, key])
        : keys.filter(item => item !== key)
      await writeFile(BLACKLIST_FILE, { version: 1, updatedAt: new Date().toISOString(), keys: next }, current?.sha ?? null,
        ban ? `authz: 封禁 ${device.slice(0, 9)}…` : `authz: 解封 ${device.slice(0, 9)}…`)
      setBanned(next)
      setTip(ban ? `已封禁 ${device}` : `已解封 ${device}`)
    } catch (err: any) {
      setTip('写入黑名单失败：' + String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [entryKeyOf, loadFile, writeFile])

  /** 按 QQ 封禁：写 blacklist.qkeys；同时把这个 QQ 对应的设备条目也拉黑 */
  const banByQQ = useCallback(async(ban: boolean) => {
    const qqValue = normalizeCode(qqInput)
    if (!isValidQQ(qqValue)) {
      Alert.alert('提示', '请先填写要封禁/解封的 QQ 号（5~12 位数字）')
      return
    }
    setBusy(true)
    setTip(ban ? '正在按 QQ 封禁…' : '正在解封 QQ…')
    try {
      const qk = await qqKeyOf(qqValue)
      const black = await loadFile(BLACKLIST_FILE)
      const keys: string[] = Array.isArray(black?.json?.keys) ? black!.json.keys as string[] : []
      const qkeys: string[] = Array.isArray(black?.json?.qkeys) ? black!.json.qkeys as string[] : []
      // 顺手把这个 QQ 名下的设备条目也封掉（老客户端只认 keys）
      const white = await loadFile(WHITELIST_FILE)
      const matchedKeys: string[] = Array.isArray(white?.json?.devices)
        ? (white!.json.devices as WhitelistEntry[]).filter(item => item && item.qk === qk).map(item => item.k)
        : []
      const nextQ = ban
        ? (qkeys.includes(qk) ? qkeys : [...qkeys, qk])
        : qkeys.filter(item => item !== qk)
      const nextK = ban
        ? [...keys, ...matchedKeys.filter(key => !keys.includes(key))]
        : keys.filter(key => !matchedKeys.includes(key))
      await writeFile(BLACKLIST_FILE, { version: 1, updatedAt: new Date().toISOString(), keys: nextK, qkeys: nextQ }, black?.sha ?? null,
        ban ? `authz: 封禁 QQ ${maskQQ(qqValue)}` : `authz: 解封 QQ ${maskQQ(qqValue)}`)
      setBanned(nextK)
      setBannedQQ(nextQ)
      setTip(ban
        ? `已封禁 QQ ${maskQQ(qqValue)}（含 ${matchedKeys.length} 台已开通设备）`
        : `已解封 QQ ${maskQQ(qqValue)}`)
    } catch (err: any) {
      setTip('按 QQ 写入黑名单失败：' + String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [loadFile, qqInput, qqKeyOf, writeFile])

  const durationExp = useCallback((): string | null => {
    const days = effectiveDays
    return days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null
  }, [effectiveDays])

  /** 解析授权申请码：校验 HMAC，展示 QQ / 头像 / 设备码，等人审 */
  const handleParseRequest = useCallback(async() => {
    const raw = requestRaw.trim()
    if (!raw) {
      Alert.alert('提示', '请粘贴用户发来的申请码（YQR1 开头）')
      return
    }
    setRequestBusy(true)
    try {
      const unpacked = unpackRequest(raw)
      if (!unpacked) throw new Error('申请码格式不正确')
      const mac = await authzNative.signText(unpacked.bodyHex)
      if (!mac || mac.slice(0, 32) !== unpacked.macHex) throw new Error('申请码校验失败（可能被改过）')
      setRequest({ ...unpacked.request, bodyHex: unpacked.bodyHex, macHex: unpacked.macHex })
      setQQInput(unpacked.request.qq)
      // 申请码里自带设备码：解析后直接回填，后面「通过并开通」就是 QQ + 设备码一起写进去
      setDeviceCode(unpacked.request.code)
      Alert.alert('申请码校验通过', '确认头像/QQ 无误后选「通过并开通」或「记入待审核」。')
    } catch (err: any) {
      setRequest(null)
      Alert.alert('解析失败', String(err?.message ?? err))
    } finally {
      setRequestBusy(false)
    }
  }, [requestRaw])

  /** 通过（或先记入待审核）：按当前时长写入白名单条目 */
  const handleApproveRequest = useCallback(async(status: 'approved' | 'pending') => {
    if (!request) return
    setRequestBusy(true)
    setTip(status === 'approved' ? '正在开通…' : '正在记入待审核…')
    try {
      const key = await entryKeyOf(request.code)
      const qk = await qqKeyOf(request.qq)
      const current = await loadFile(WHITELIST_FILE)
      const list: WhitelistEntry[] = Array.isArray(current?.json?.devices)
        ? (current!.json.devices as WhitelistEntry[]).filter(item => item && item.k !== key)
        : []
      const entry: WhitelistEntry = {
        k: key,
        exp: durationExp(),
        at: new Date().toISOString(),
        qq: maskQQ(request.qq),
        qk,
        nick: request.nick || undefined,
        status,
      }
      list.push(entry)
      await writeFile(WHITELIST_FILE, { version: 1, updatedAt: new Date().toISOString(), devices: list }, current?.sha ?? null,
        status === 'approved' ? `authz: 审核通过 QQ ${maskQQ(request.qq)}` : `authz: 待审核 QQ ${maskQQ(request.qq)}`)
      setDevices(list)
      setTip(status === 'approved'
        ? `已开通 QQ ${maskQQ(request.qq)} · 让用户点「刷新授权状态」`
        : `已记入待审核：QQ ${maskQQ(request.qq)}（用户那边会显示"待管理员审核"）`)
      if (status === 'approved') setRequest(null)
    } catch (err: any) {
      setTip((status === 'approved' ? '开通失败：' : '写入失败：') + String(err?.message ?? err))
    } finally {
      setRequestBusy(false)
    }
  }, [durationExp, entryKeyOf, loadFile, qqKeyOf, request, writeFile])

  /** 拒绝：直接按 QQ 封禁（同时拉黑设备条目） */
  const handleRejectRequest = useCallback(() => {
    if (!request) return
    Alert.alert('拒绝并封禁', `确定封禁 QQ ${maskQQ(request.qq)}？换设备也无法使用。`, [
      { text: '取消', style: 'cancel' },
      { text: '拒绝并封禁', style: 'destructive', onPress: () => { setQQInput(request.qq); void banByQQ(true).then(() => setRequest(null)) } },
    ])
  }, [banByQQ, request])

  /** 待审核列表里点「通过」：把已有条目从 pending 改成 approved */
  const approveEntry = useCallback(async(entry: WhitelistEntry) => {
    setRequestBusy(true)
    setTip('正在通过…')
    try {
      const current = await loadFile(WHITELIST_FILE)
      const list: WhitelistEntry[] = Array.isArray(current?.json?.devices)
        ? (current!.json.devices as WhitelistEntry[]).map(item => item && item.k === entry.k ? { ...item, status: 'approved' as const, exp: item.exp ?? durationExp() } : item)
        : []
      await writeFile(WHITELIST_FILE, { version: 1, updatedAt: new Date().toISOString(), devices: list }, current?.sha ?? null,
        `authz: 审核通过 ${entry.qq || entry.k.slice(0, 8)}`)
      setDevices(list)
      setTip(`已通过 ${entry.qq || entry.k.slice(0, 8)}`)
    } catch (err: any) {
      setTip('通过失败：' + String(err?.message ?? err))
    } finally {
      setRequestBusy(false)
    }
  }, [durationExp, loadFile, writeFile])

  const handleBan = useCallback(() => {
    const device = validateInput()
    if (!device) return
    void setBannedState(device, true)
  }, [setBannedState, validateInput])

  const handleUnban = useCallback(() => {
    const device = validateInput()
    if (!device) return
    void setBannedState(device, false)
  }, [setBannedState, validateInput])

  // ---------------------------------------------------------------- 离线授权串

  const handleOfflineAuth = useCallback(async() => {
    const device = validateInput()
    if (!device) return
    setBusy(true)
    setTip('正在用 RSA 私钥签发…')
    try {
      const privateKey = LICENSE_PRIVATE_KEY as { n?: string, d?: string } | undefined
      if (!privateKey?.n || !privateKey?.d || privateKey.n.length < 128) {
        throw new Error('管理端缺少私钥：请在 CI 里配置 Secret LICENSE_KEYPAIR_B64（scripts/write-admin-key.js 注入）')
      }
      const expToken = toExpToken(effectiveDays > 0 ? new Date(Date.now() + effectiveDays * 86400000).toISOString() : null)
      const payload = buildOfflineAuthPayload(device, expToken)
      const signature = rsaSign(privateKey, payload)
      const packed = packOfflineAuth(expToken, signature)
      // 自检：签出来的串必须能被客户端内置公钥验过，否则就是私钥没注入对了
      if (!rsaVerify(LICENSE_PUBLIC_KEY, payload, signature)) {
        throw new Error('私钥与客户端公钥不匹配：管理端私钥没有注入（CI 需要 Secret LICENSE_KEYPAIR_B64）')
      }
      setOfflineAuth(packed)
      setTip(`离线授权串已生成（${expToken === '20991231' ? '永久' : '至 ' + expToken}），发给用户粘贴一次即可`)
    } catch (err: any) {
      setTip('签发失败：' + String(err?.message ?? err))
      Alert.alert('签发失败', String(err?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [effectiveDays, validateInput])

  const statusLine = useMemo(() => tip, [tip])

  if (!booted) return <View style={styles.page} />

  if (!unlocked) {
    return (
      <SafeAreaView style={styles.page}>
        <ScrollView contentContainerStyle={styles.loginWrap} keyboardShouldPersistTaps="handled">
          <Text style={styles.brandTitle}>Yieyu Admin</Text>
          <Text style={styles.brandSub}>设备授权工具 · 需口令登录</Text>

          <View style={styles.inputBox}>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="请输入管理员口令"
              placeholderTextColor="#5a6270"
              secureTextEntry={!showPwd}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={handleLogin}
              style={styles.input}
            />
          </View>
          <Pressable onPress={() => setShowPwd(v => !v)} style={({ pressed }) => [styles.eyeBtn, pressed && styles.pressed]}>
            <Text style={styles.eyeText}>{showPwd ? '隐藏口令' : '显示口令'}</Text>
          </Pressable>
          {loginError ? <Text style={styles.error}>{loginError}</Text> : null}

          <Pressable onPress={handleLogin} style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}>
            <Text style={styles.primaryText}>进入</Text>
          </Pressable>

          <Text style={styles.hint}>登录一次后会记住登录状态，重开无需再输口令（可在主界面「退出登录」）。</Text>

          <View style={styles.dangerBox}>
            <Text style={styles.dangerTitle}>⚠️ 私钥所在，严禁外传</Text>
            <Text style={styles.dangerText}>
              本应用可签发离线授权串、可改云端白名单，请勿安装到他人设备、勿分享 APK。
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.mainWrap} keyboardShouldPersistTaps="handled">
        <View style={styles.headRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.brandTitle}>夜雨 · 设备授权</Text>
            <Text style={styles.brandSub}>填设备码 → 写白名单；用户在自己手机上录指纹</Text>
          </View>
          <Pressable onPress={handleLogout} style={({ pressed }) => [styles.logoutBtn, pressed && styles.pressed]}>
            <Text style={styles.logoutText}>退出登录</Text>
          </Pressable>
        </View>

        <View style={styles.dangerBox}>
          <Text style={styles.dangerTitle}>⚠️ 严禁外传</Text>
          <Text style={styles.dangerText}>本 APK 含 RSA 私钥与白名单写权限，不要分享给任何人。</Text>
        </View>

        <Text style={styles.hint}>设备码不用填：解析申请码时自动带出（授权只认 QQ + 申请码）。</Text>

        <Text style={styles.label}>用户 QQ 号（开通时填 → 以后按 QQ 认人/封禁）</Text>
        <View style={styles.inputBox}>
          <TextInput
            value={qqInput}
            onChangeText={setQQInput}
            placeholder="例如 12345678（5~12 位数字）"
            placeholderTextColor="#5a6270"
            keyboardType="number-pad"
            autoCorrect={false}
            style={styles.input}
          />
        </View>
        <Text style={styles.hint}>公开名单里只存掩码（123***89）和 HMAC，不会把 QQ 明文推到网上</Text>

        <Text style={styles.label}>时长选择</Text>
        <View style={styles.chipRow}>
          {VALIDITY_OPTIONS.map(option => {
            const active = option.days === days
            return (
              <Pressable
                key={option.label}
                onPress={() => { setDays(option.days); setCustomMode(false) }}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
              </Pressable>
            )
          })}
          <Pressable
            onPress={() => { setDays(-1); setCustomMode(true) }}
            style={[styles.chip, days === -1 && styles.chipActive]}
          >
            <Text style={[styles.chipText, days === -1 && styles.chipTextActive]}>自定义</Text>
          </Pressable>
        </View>

        {customMode
          ? (
            <View style={styles.inputBox}>
              <TextInput
                value={customDays}
                onChangeText={setCustomDays}
                placeholder="输入天数，例如 180"
                placeholderTextColor="#5a6270"
                keyboardType="number-pad"
                style={styles.input}
              />
            </View>
          )
          : null}

        <Pressable onPress={() => { void handleAuthorize() }} style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}>
          <Text style={styles.primaryText}>{busy ? '处理中…' : '开通 / 续期（写云端白名单）'}</Text>
        </Pressable>

        <View style={{ flexDirection: 'row', marginTop: 10 }}>
          <Pressable onPress={handleRemove} style={({ pressed }) => [styles.secondaryBtn, { flex: 1, marginRight: 8, marginTop: 0 }, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>移除该 QQ 的授权</Text>
          </Pressable>
          <Pressable onPress={() => { void handleOfflineAuth() }} style={({ pressed }) => [styles.secondaryBtn, { flex: 1, marginTop: 0 }, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>生成离线授权串</Text>
          </Pressable>
        </View>

        {statusLine ? <Text style={{ color: '#e3b341', fontSize: 12, marginTop: 10, lineHeight: 18 }}>{statusLine}</Text> : null}

        {offlineAuth
          ? (
            <View style={{ marginTop: 18 }}>
              <Text style={styles.label}>离线授权串（长按复制发给用户）</Text>
              <View style={styles.cardBox}>
                <Text selectable style={styles.offlineText}>{offlineAuth}</Text>
              </View>
              <Text style={styles.hint}>
                用户在客户端授权页「换手机 / 没网」里粘贴一次，验证指纹后即绑定；同一串只能在本机设备码上生效。
              </Text>
            </View>
          )
          : null}

        <View style={{ marginTop: 30, borderTopWidth: 1, borderTopColor: '#2b303b', paddingTop: 20 }}>
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>授权申请（用户发来的 YQR1 申请码）</Text>
          <Text style={styles.hint}>用户在授权页核对头像后生成申请码；这里粘贴 → 校验 HMAC → 看头像/QQ/设备码 → 通过或待审核。</Text>
          <View style={styles.inputBox}>
            <TextInput
              value={requestRaw}
              onChangeText={setRequestRaw}
              placeholder="粘贴 YQR1.xxxx.xxxx"
              placeholderTextColor="#5a6270"
              autoCapitalize="characters"
              autoCorrect={false}
              multiline
              style={[styles.input, { minHeight: 56, fontSize: 12 }]}
            />
          </View>
          <Pressable onPress={() => { void handleParseRequest() }} style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>{requestBusy ? '解析中…' : '解析申请码'}</Text>
          </Pressable>

          {request
            ? (
              <View style={{ marginTop: 12, backgroundColor: '#0d1117', borderRadius: 10, borderWidth: 1, borderColor: '#2b303b', padding: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Image source={{ uri: avatarUrlOf(request.qq) }} style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: '#1c1f26' }} />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>{request.qq}</Text>
                    <Text style={{ color: '#8b93a1', fontSize: 12, marginTop: 2 }}>{request.nick || '（昵称未知，请看头像核对）'}</Text>
                    <Text selectable style={{ color: '#7ee0ff', fontSize: 11, marginTop: 4 }}>设备码 {request.code}</Text>
                  </View>
                </View>
                <View style={{ flexDirection: 'row', marginTop: 12 }}>
                  <Pressable onPress={() => { void handleApproveRequest('approved') }} style={({ pressed }) => [styles.primaryBtn, { flex: 1, marginRight: 8, marginTop: 0, backgroundColor: '#238636' }, pressed && styles.pressed]}>
                    <Text style={styles.primaryText}>通过并开通</Text>
                  </Pressable>
                  <Pressable onPress={() => { void handleApproveRequest('pending') }} style={({ pressed }) => [styles.secondaryBtn, { flex: 1, marginTop: 0, marginRight: 8 }, pressed && styles.pressed]}>
                    <Text style={styles.secondaryText}>记入待审核</Text>
                  </Pressable>
                  <Pressable onPress={handleRejectRequest} style={({ pressed }) => [styles.unbanBtn, { paddingHorizontal: 12, marginTop: 0 }, pressed && styles.pressed]}>
                    <Text style={styles.secondaryText}>拒绝</Text>
                  </Pressable>
                </View>
              </View>
            )
            : null}
        </View>

        <View style={{ marginTop: 30, borderTopWidth: 1, borderTopColor: '#2b303b', paddingTop: 20 }}>
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>云端名单</Text>
          <Text style={styles.hint}>
            {WHITELIST_FILE} 决定谁能用；{BLACKLIST_FILE} 是封禁（客户端联网即锁死）。
          </Text>

          <Text style={styles.label}>GitHub Token（只存本机）</Text>
          <View style={styles.inputBox}>
            <TextInput
              value={token}
              onChangeText={setToken}
              placeholder={tokenSaved ? '已保存，可覆盖' : 'ghp_xxx（需要 repo 写权限）'}
              placeholderTextColor="#5a6270"
              autoCapitalize="none"
              secureTextEntry
              style={styles.input}
            />
          </View>
          <Pressable onPress={() => { void persistToken() }} style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>{tokenSaved ? '更新 Token' : '保存 Token'}</Text>
          </Pressable>

          <View style={{ flexDirection: 'row', marginTop: 10 }}>
            <Pressable onPress={() => { void banByQQ(true) }} style={({ pressed }) => [styles.primaryBtn, { flex: 1, marginRight: 8, marginTop: 0, backgroundColor: '#f85149' }, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>{busy ? '处理中…' : '按 QQ 封禁（换设备也拦）'}</Text>
            </Pressable>
            <Pressable onPress={() => { void banByQQ(false) }} style={({ pressed }) => [styles.unbanBtn, pressed && styles.pressed]}>
              <Text style={styles.secondaryText}>解封 QQ</Text>
            </Pressable>
          </View>

          <Pressable onPress={() => { void refreshLists() }} style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>刷新云端名单</Text>
          </Pressable>
          {listTip ? <Text style={{ color: '#8b93a1', fontSize: 12, marginTop: 8 }}>{listTip}</Text> : null}

          <Text style={styles.label}>已开通设备（{devices.length} 台）</Text>
          {devices.length === 0
            ? <Text style={styles.hint}>暂无授权，点上面「刷新云端名单」拉取</Text>
            : (
              <View style={styles.banListBox}>
                {devices.slice(-15).reverse().map(item => (
                  <View key={item.k} style={styles.banRow}>
                    <Text selectable style={styles.banHash}>{item.qq ? item.qq : '未绑QQ'}</Text>
                    <Text selectable style={styles.banHash}>{maskKey(item.k)}</Text>
                    {item.status === 'pending'
                      ? (
                        <Pressable onPress={() => { void approveEntry(item) }} style={({ pressed }) => [styles.banDelBtn, pressed && styles.pressed]}>
                          <Text style={styles.banDelText}>待审核 · 点通过</Text>
                        </Pressable>
                      )
                      : <Text style={styles.banExp}>{item.exp ? item.exp.slice(0, 10) : '永久'}</Text>}
                  </View>
                ))}
                {devices.length > 15 ? <Text style={styles.hint}>仅显示最新 15 台，共 {devices.length} 台</Text> : null}
              </View>
            )}

          <Text style={styles.label}>黑名单（设备 {banned.length} 条 · QQ {bannedQQ.length} 个）</Text>
          {banned.length === 0
            ? <Text style={styles.hint}>暂无封禁</Text>
            : (
              <View style={styles.banListBox}>
                {banned.slice(-10).reverse().map(key => (
                  <Text key={key} selectable style={styles.banHash}>{maskKey(key)}</Text>
                ))}
              </View>
            )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
})

export default AdminApp

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#14161a' },
  loginWrap: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  mainWrap: { padding: 20, paddingBottom: 48 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start' },
  brandTitle: { fontSize: 24, fontWeight: '800', color: '#fff' },
  brandSub: { fontSize: 12, color: '#8b93a1', marginTop: 6 },
  label: { color: '#c9d1d9', fontSize: 13, marginTop: 22, marginBottom: 8 },
  inputBox: {
    backgroundColor: '#1c1f26', borderRadius: 10, paddingHorizontal: 12,
    borderWidth: 1, borderColor: '#2b303b', marginTop: 8,
  },
  input: { color: '#fff', fontSize: 15, paddingVertical: 12 },
  hint: { color: '#6b7280', fontSize: 11, lineHeight: 17, marginTop: 8 },
  error: { color: '#ff3b30', fontSize: 12, marginTop: 8 },
  eyeBtn: { alignSelf: 'flex-end', paddingVertical: 8, paddingHorizontal: 2 },
  eyeText: { color: '#8b93a1', fontSize: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 16, paddingVertical: 9, borderRadius: 20, marginRight: 8, marginBottom: 8,
    backgroundColor: '#1c1f26', borderWidth: 1, borderColor: '#2b303b',
  },
  chipActive: { backgroundColor: '#2f81f7', borderColor: '#2f81f7' },
  chipText: { color: '#9aa4b2', fontSize: 13 },
  chipTextActive: { color: '#fff' },
  primaryBtn: { marginTop: 16, backgroundColor: '#2f81f7', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondaryBtn: { marginTop: 10, backgroundColor: '#1c1f26', borderRadius: 10, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#2b303b' },
  secondaryText: { color: '#c9d1d9', fontSize: 14 },
  pressed: { opacity: 0.75 },
  logoutBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#2b303b', backgroundColor: '#1c1f26', marginLeft: 12 },
  logoutText: { color: '#9aa4b2', fontSize: 12 },
  unbanBtn: { backgroundColor: '#1c1f26', borderRadius: 10, paddingVertical: 14, paddingHorizontal: 18, alignItems: 'center', borderWidth: 1, borderColor: '#2b303b' },
  banListBox: { backgroundColor: '#0d1117', borderRadius: 10, borderWidth: 1, borderColor: '#2b303b', padding: 10, marginTop: 4 },
  banRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 },
  banHash: { color: '#8b93a1', fontSize: 12, fontFamily: 'monospace' },
  banExp: { color: '#7ee787', fontSize: 12, fontFamily: 'monospace' },
  cardBox: { backgroundColor: '#0d1117', borderRadius: 10, borderWidth: 1, borderColor: '#2b303b', padding: 14 },
  offlineText: { color: '#7ee787', fontSize: 11, lineHeight: 17, fontFamily: 'monospace' },
  dangerBox: {
    marginTop: 20, padding: 12, borderRadius: 10,
    backgroundColor: 'rgba(255,59,48,0.10)', borderWidth: 1, borderColor: '#ff3b30',
  },
  dangerTitle: { color: '#ff3b30', fontSize: 13, fontWeight: '800' },
  dangerText: { color: '#ff7b72', fontSize: 11, marginTop: 4, lineHeight: 17 },
})
