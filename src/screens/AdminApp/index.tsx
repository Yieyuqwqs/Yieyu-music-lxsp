import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { createCardKey } from '@/utils/licenseCard'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '@/utils/sha256'

const OWNER = 'Yieyuqwqs'
const REPO = 'Yieyu-music'
const BRANCH = 'main'
const BLACKLIST_FILE = 'blacklist.json'
const TOKEN_STORE_KEY = 'yieyu.admin.token'
// 登录态持久化：登录一次后重开管理端无需再输口令，直到手动「退出登录」
const SESSION_STORE_KEY = 'yieyu.admin.session'
// 已签发过的卡密（防止重复生成同一张）
const ISSUED_STORE_KEY = 'yieyu.admin.issued'

/** 生成一张没发过的卡密，并写入已签发列表 */
const generateUniqueCard = async (device: string, expiresAt: string | null): Promise<string> => {
  let issued: string[] = []
  try {
    const stored = await AsyncStorage.getItem(ISSUED_STORE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) issued = parsed.filter(item => typeof item === 'string')
    }
  } catch {}
  let card = createCardKey(device, expiresAt)
  for (let i = 0; i < 30 && issued.includes(card); i++) card = createCardKey(device, expiresAt)
  const next = [...issued, card].slice(-500)
  try { await AsyncStorage.setItem(ISSUED_STORE_KEY, JSON.stringify(next)) } catch {}
  return card
}

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error('网络超时')) }, ms)
  promise.then(
    (value) => { clearTimeout(timer); resolve(value) },
    (err) => { clearTimeout(timer); reject(err) },
  )
})

const ghFetch = async (token: string, path: string, init?: any) => withTimeout(fetch('https://api.github.com' + path, {
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
// 兼容旧写法（结尾没有点的版本），避免用户漏打结尾的点时进不去
const LEGACY_PASSWORD_HASHES = [
  'ee005e159819254a99c2b1587aae9c5405a34b5312879c639f0a44fba1327344',
]

/** 口令归一化：中文输入法可能输入全角字符/带空格，统一转半角并去空白 */
const normalizePassword = (raw: string) => String(raw ?? '')
  .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  .replace(/\s+/g, '')
  .replace(/[\u200B-\u200D\uFEFF]/g, '')
  .replace(/[\u3002\uFF61]/g, '.')
  .trim()

/** 返回 true=口令正确；false=错误；同时给出本次输入的口令哈希（前 8 位，便于排查） */
const checkPassword = (raw: string): { ok: boolean, hash: string } => {
  const normalized = normalizePassword(raw)
  if (!normalized) return { ok: false, hash: '' }
  const allowed = [ADMIN_PASSWORD_HASH, ...LEGACY_PASSWORD_HASHES]
  for (const candidate of [normalized, normalized.toLowerCase(), normalized.toUpperCase().toLowerCase()]) {
    const hash = sha256(candidate)
    if (allowed.includes(hash)) return { ok: true, hash }
  }
  return { ok: false, hash: sha256(normalized) }
}

const VALIDITY_OPTIONS = [
  { label: '1 天', days: 1 },
  { label: '7 天', days: 7 },
  { label: '30 天', days: 30 },
  { label: '365 天', days: 365 },
  { label: '永久', days: 0 },
]

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
  const [card, setCard] = useState('')
  const [genBusy, setGenBusy] = useState(false)
  const [token, setToken] = useState('')
  const [tokenSaved, setTokenSaved] = useState(false)
  const [banKey, setBanKey] = useState('')
  const [banBusy, setBanBusy] = useState(false)
  const [banList, setBanList] = useState<string[]>([])
  const [banTip, setBanTip] = useState('')
  const [cardMeta, setCardMeta] = useState('')

  const loadToken = useCallback(async() => {
    try {
      const saved = await AsyncStorage.getItem(TOKEN_STORE_KEY)
      if (saved) { setToken(saved); setTokenSaved(true) }
    } catch {}
  }, [])

  // 启动时恢复登录态：不用每次重开都重新输口令
  useEffect(() => {
    let alive = true
    void (async() => {
      try {
        const [session, savedToken] = await Promise.all([
          AsyncStorage.getItem(SESSION_STORE_KEY),
          AsyncStorage.getItem(TOKEN_STORE_KEY),
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
      void loadToken()
    } else {
      setLoginError(password.trim()
        ? `口令不正确（校验 ${result.hash.slice(0, 8)}…）`
        : '请输入口令')
    }
  }, [password, loadToken])

  const handleLogout = useCallback(() => {
    Alert.alert('退出登录', '下次打开需要重新输入口令。', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: () => {
          setUnlocked(false)
          setCard('')
          setCardMeta('')
          AsyncStorage.removeItem(SESSION_STORE_KEY).catch(() => {})
        },
      },
    ])
  }, [])

  const handleGenerate = useCallback(() => {
    const device = deviceCode.trim()
    if (!device) {
      Alert.alert('提示', '请先填写用户提供的设备码')
      return
    }
    if (device.replace(/[^0-9a-zA-Z]/g, '').length < 8) {
      Alert.alert('提示', '设备码看起来不完整，请让用户重新复制一次')
      return
    }
    const effectiveDays = days === -1 ? Number(customDays) : days
    if (days === -1 && (!effectiveDays || effectiveDays <= 0)) {
      Alert.alert('提示', '请输入有效的天数')
      return
    }
    const expiresAt = effectiveDays > 0 ? new Date(Date.now() + effectiveDays * 86400000).toISOString() : null
    setGenBusy(true)
    void generateUniqueCard(device, expiresAt)
      .then((key) => {
        setCard(key)
        setCardMeta(effectiveDays > 0 ? `${effectiveDays} 天 · 至 ${expiresAt!.slice(0, 10)}` : '永久有效')
      })
      .catch((err: any) => { Alert.alert('生成失败', String(err?.message ?? err)) })
      .finally(() => setGenBusy(false))
  }, [deviceCode, days, customDays])

  const persistToken = useCallback(async() => {
    try {
      await AsyncStorage.setItem(TOKEN_STORE_KEY, token.trim())
      setTokenSaved(true)
      Alert.alert('已保存', 'Token 只存在本机，不会写进 APK')
    } catch (err: any) {
      Alert.alert('保存失败', String(err?.message ?? err))
    }
  }, [token])

  const fetchBlacklist = useCallback(async() => {
    try {
      const res = await ghFetch(token, '/repos/' + OWNER + '/' + REPO + '/contents/' + BLACKLIST_FILE + '?ref=' + BRANCH)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const json = await res.json()
      const text = Buffer.from(String(json.content).replace(/\s/g, ''), 'base64').toString('utf8')
      const data = JSON.parse(text)
      const keys = Array.isArray(data.keys) ? data.keys : []
      setBanList(keys)
      return { keys, sha: json.sha as string }
    } catch (err: any) {
      setBanTip('读取黑名单失败：' + String(err?.message ?? err))
      return null
    }
  }, [token])

  /** 把最新的云端黑名单拉下来（用于列表展示） */
  const loadCloudList = useCallback(async(): Promise<string[] | null> => {
    if (!token) return null
    const current = await fetchBlacklist()
    return current ? current.keys : null
  }, [token, fetchBlacklist])

  /** 云端黑名单写入（封禁 / 解封共用） */
  const pushCloudList = useCallback(async(keys: string[], message: string) => {
    const current = await fetchBlacklist()
    if (!current) throw new Error('读取云端黑名单失败')
    const next = { version: 1, updatedAt: new Date().toISOString(), keys }
    const res = await ghFetch(token, '/repos/' + OWNER + '/' + REPO + '/contents/' + BLACKLIST_FILE, {
      method: 'PUT',
      body: JSON.stringify({
        message,
        content: Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8').toString('base64'),
        sha: current.sha,
        branch: BRANCH,
      }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    setBanList(next.keys)
  }, [token, fetchBlacklist])

  const banCardKey = useCallback(async() => {
    const raw = banKey.trim().replace(/\s/g, '')
    if (!raw) { Alert.alert('提示', '请粘贴要封禁的卡密'); return }
    if (!token) { Alert.alert('需要 GitHub Token', '请先在下方填写并保存 Token，封禁/解封都要写云端。'); return }
    setBanBusy(true)
    setBanTip('正在写入云端…')
    try {
      const hash = sha256('yieyu-card:' + raw.toUpperCase())
      const current = await fetchBlacklist()
      if (!current) { setBanBusy(false); return }
      if (current.keys.includes(hash)) {
        setBanTip('该卡密已在黑名单里（' + current.keys.length + ' 张）')
        Alert.alert('已在黑名单', '这张卡密之前就封禁过了。')
        setBanBusy(false)
        return
      }
      await pushCloudList([...current.keys, hash], 'blacklist: 封禁 1 张卡密')
      setBanKey('')
      setBanTip('已封禁，云端共 ' + (current.keys.length + 1) + ' 张')
      Alert.alert('已封禁', '已写入云端黑名单。客户端联网激活会被拒绝（镜像一般 0.5~90 秒生效）。')
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      setBanTip('封禁失败：' + msg)
      Alert.alert('封禁失败', msg)
    } finally {
      setBanBusy(false)
    }
  }, [banKey, token, fetchBlacklist, pushCloudList])

  const unbanCardKey = useCallback(async() => {
    const raw = banKey.trim().replace(/\s/g, '')
    if (!raw) { Alert.alert('提示', '请粘贴要解封的卡密'); return }
    if (!token) { Alert.alert('需要 GitHub Token', '请先在下方填写并保存 Token，封禁/解封都要写云端。'); return }
    setBanBusy(true)
    setBanTip('正在写入云端…')
    try {
      const hash = sha256('yieyu-card:' + raw.toUpperCase())
      const current = await fetchBlacklist()
      if (!current) { setBanBusy(false); return }
      if (!current.keys.includes(hash)) {
        setBanTip('该卡密不在黑名单里')
        Alert.alert('无需解封', '云端黑名单里没有这张卡密。')
        setBanBusy(false)
        return
      }
      const keys = current.keys.filter(item => item !== hash)
      await pushCloudList(keys, 'blacklist: 解封 1 张卡密')
      setBanKey('')
      setBanTip('已解封，云端剩 ' + keys.length + ' 张')
      Alert.alert('已解封', '已从云端黑名单移除，客户端下次激活即可通过。')
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      setBanTip('解封失败：' + msg)
      Alert.alert('解封失败', msg)
    } finally {
      setBanBusy(false)
    }
  }, [banKey, token, fetchBlacklist, pushCloudList])

  /** 刷新云端列表 */
  const handleRefreshList = useCallback(() => {
    if (!token) { Alert.alert('需要 GitHub Token', '请先填写并保存 Token'); return }
    setBanTip('正在拉取云端列表…')
    void loadCloudList()
      .then((keys) => { if (keys) setBanTip('云端当前 ' + keys.length + ' 条') })
      .catch((err: any) => { setBanTip('拉取失败：' + String(err?.message ?? err)) })
  }, [token, loadCloudList])

  /** 列表里点「解封」：直接按哈希移除 */
  const unbanByHash = useCallback(async(hash: string) => {
    if (!token) { Alert.alert('需要 GitHub Token', '请先保存 Token'); return }
    setBanBusy(true)
    try {
      const current = await fetchBlacklist()
      if (!current) { setBanBusy(false); return }
      const keys = current.keys.filter(item => item !== hash)
      await pushCloudList(keys, 'blacklist: 解封 1 张卡密')
      setBanTip('已解封，云端剩 ' + keys.length + ' 张')
    } catch (err: any) {
      setBanTip('解封失败：' + String(err?.message ?? err))
    } finally {
      setBanBusy(false)
    }
  }, [token, fetchBlacklist, pushCloudList])

  const statusLine = useMemo(() => cardMeta, [cardMeta])

  if (!booted) return <View style={styles.page} />

  if (!unlocked) {
    return (
      <SafeAreaView style={styles.page}>
        <ScrollView contentContainerStyle={styles.loginWrap} keyboardShouldPersistTaps="handled">
          <Text style={styles.brandTitle}>Yieyu Admin</Text>
          <Text style={styles.brandSub}>卡密签发工具 · 需口令登录</Text>

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
              本应用为卡密签发端，请勿安装到他人设备、勿分享 APK。
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
            <Text style={styles.brandTitle}>夜雨 · 卡密生成器</Text>
            <Text style={styles.brandSub}>Yieyu Admin Tool · 离线签发 16 位卡密</Text>
          </View>
          <Pressable onPress={handleLogout} style={({ pressed }) => [styles.logoutBtn, pressed && styles.pressed]}>
            <Text style={styles.logoutText}>退出登录</Text>
          </Pressable>
        </View>

        <View style={styles.dangerBox}>
          <Text style={styles.dangerTitle}>⚠️ 严禁外传</Text>
          <Text style={styles.dangerText}>本 APK 可签发任意卡密，不要分享给任何人。</Text>
        </View>

        <Text style={styles.label}>用户设备码</Text>
        <View style={styles.inputBox}>
          <TextInput
            value={deviceCode}
            onChangeText={setDeviceCode}
            placeholder="例如 AB12-CD34-EF56-7890"
            placeholderTextColor="#5a6270"
            autoCapitalize="characters"
            autoCorrect={false}
            style={styles.input}
          />
        </View>
        <Text style={styles.hint}>让用户在客户端授权页复制设备码发给你</Text>

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

        <Pressable onPress={handleGenerate} style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}>
          <Text style={styles.primaryText}>{genBusy ? '生成中…' : '生成卡密（每次都不一样）'}</Text>
        </Pressable>

        {card
          ? (
            <View style={{ marginTop: 18 }}>
              <Text style={styles.label}>生成结果（{statusLine} · 已绑定设备码）</Text>
              <View style={styles.cardBox}>
                <Text selectable style={styles.cardText}>{card}</Text>
              </View>
              <Text style={styles.hint}>
                16 位短卡密，长按上方文字复制后直接发给用户；用户在客户端「授权页」粘贴即可激活。
              </Text>
            </View>
          )
          : null}

        <View style={{ marginTop: 30, borderTopWidth: 1, borderTopColor: '#2b303b', paddingTop: 20 }}>
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>黑名单管理（云端）</Text>
          <Text style={styles.hint}>封禁与解封都会写入仓库 blacklist.json；客户端联网激活时生效（镜像一般 0.5~90 秒），断网时降级为只校验卡密。</Text>

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
          <Pressable onPress={persistToken} style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>{tokenSaved ? '更新 Token' : '保存 Token'}</Text>
          </Pressable>

          <Text style={styles.label}>卡密</Text>
          <View style={styles.inputBox}>
            <TextInput
              value={banKey}
              onChangeText={setBanKey}
              placeholder="粘贴 16 位卡密，例如 YIEYU-XXXX-XXXXX"
              placeholderTextColor="#5a6270"
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.input}
            />
          </View>
          <View style={{ flexDirection: 'row', marginTop: 12 }}>
            <Pressable onPress={banCardKey} style={({ pressed }) => [styles.primaryBtn, { flex: 1, marginTop: 0, marginRight: 8 }, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>{banBusy ? '处理中…' : '封禁'}</Text>
            </Pressable>
            <Pressable onPress={unbanCardKey} style={({ pressed }) => [styles.unbanBtn, pressed && styles.pressed]}>
              <Text style={styles.secondaryText}>解封</Text>
            </Pressable>
          </View>
          <Pressable onPress={handleRefreshList} style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>刷新云端列表</Text>
          </Pressable>
          {banTip ? <Text style={{ color: '#e3b341', fontSize: 12, marginTop: 8 }}>{banTip}</Text> : null}

          <Text style={styles.label}>云端黑名单（{banList.length} 条）</Text>
          {banList.length === 0
            ? <Text style={styles.hint}>暂无封禁记录，点上面「刷新云端列表」拉取</Text>
            : (
              <View style={styles.banListBox}>
                {banList.slice(-20).reverse().map(hash => (
                  <View key={hash} style={styles.banRow}>
                    <Text selectable style={styles.banHash}>{String(hash).slice(0, 16)}…</Text>
                    <Pressable onPress={() => { void unbanByHash(hash) }} style={({ pressed }) => [styles.banDelBtn, pressed && styles.pressed]}>
                      <Text style={styles.banDelText}>解封</Text>
                    </Pressable>
                  </View>
                ))}
                {banList.length > 20 ? <Text style={styles.hint}>仅显示最新 20 条，共 {banList.length} 条</Text> : null}
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
  banDelBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: '#1c1f26', borderWidth: 1, borderColor: '#2b303b' },
  banDelText: { color: '#7ee787', fontSize: 12 },
  cardBox: { backgroundColor: '#0d1117', borderRadius: 10, borderWidth: 1, borderColor: '#2b303b', padding: 14, alignItems: 'center' },
  cardText: { color: '#7ee787', fontSize: 20, lineHeight: 28, fontFamily: 'monospace', letterSpacing: 1.5 },
  dangerBox: {
    marginTop: 20, padding: 12, borderRadius: 10,
    backgroundColor: 'rgba(255,59,48,0.10)', borderWidth: 1, borderColor: '#ff3b30',
  },
  dangerTitle: { color: '#ff3b30', fontSize: 13, fontWeight: '800' },
  dangerText: { color: '#ff7b72', fontSize: 11, marginTop: 4, lineHeight: 17 },
})
