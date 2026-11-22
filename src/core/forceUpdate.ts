import { AppState, NativeModules } from 'react-native'
import guardActions from '@/store/guard/action'
import guardState from '@/store/guard/state'
import { UPDATE_DOWNLOAD_URL, UPDATE_GUARD_URLS, UPDATE_RETRY_INTERVAL } from '@/config/updateGuard'
import { compareVersion, normalizeVersionCode } from '@/utils/versionCompare'
import { appendFile, externalStorageDirectoryPath, privateStorageDirectoryPath } from '@/utils/fs'

export interface UpdateInfo {
  minSupportedVersion?: string
  latestVersion?: string
  /** 云端整型版本号，存在时优先级高于字符串比较 */
  versionCode?: number
  minVersionCode?: number
  downloadUrl?: string
  message?: string
}

const utilsBridge = NativeModules.UtilsModule as {
  getVersionCode?: () => Promise<number>
  getVersionName?: () => Promise<string>
} | undefined

/** 取本机整型 versionCode（原生 PackageManager，拿不到返回 0） */
export const getLocalVersionCode = async(): Promise<number> => {
  try {
    if (!utilsBridge?.getVersionCode) return 0
    const code = await utilsBridge.getVersionCode()
    return typeof code === 'number' && code > 0 ? Math.floor(code) : 0
  } catch {
    return 0
  }
}

/** 取本机 versionName（原生 PackageManager，拿不到返回空串） */
export const getLocalVersionName = async(): Promise<string> => {
  try {
    if (!utilsBridge?.getVersionName) return ''
    const name = await utilsBridge.getVersionName()
    return typeof name === 'string' ? name : ''
  } catch {
    return ''
  }
}

const diagFile = () => `${externalStorageDirectoryPath}/Download/lx_version_diag.txt`
const diagFallback = () => `${privateStorageDirectoryPath}/lx_version_diag.txt`

/** 诊断日志：每次校验都留一行，出问题让用户把这个文件发出来，不再靠猜 */
const writeDiag = (line: string) => {
  const text = `${new Date().toISOString()} ${line}\n`
  void appendFile(diagFile(), text).catch(() => {
    void appendFile(diagFallback(), text).catch(() => {})
  })
}

const fetchUpdateInfo = async(): Promise<{ info: UpdateInfo, url: string }> => {
  let lastErr: Error | null = null
  for (const url of UPDATE_GUARD_URLS) {
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, { headers: { 'User-Agent': 'Yieyu-music' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as UpdateInfo
      if (!data || !data.minSupportedVersion) throw new Error('数据格式错误')
      return { info: data, url }
    } catch (err) {
      lastErr = err as Error
    }
  }
  throw lastErr ?? new Error('network failed')
}

let retryTimer: ReturnType<typeof setTimeout> | null = null
let started = false

const scheduleRetry = () => {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void checkForceUpdate()
  }, UPDATE_RETRY_INTERVAL)
}

/**
 * 强更校验：只有「整型 versionCode 与字符串版本号都认为本机过旧」才拦截。
 * 任一信号说本机不旧就放行 —— 宁可漏判，也绝不把已装最新版的人锁在门外。
 */
export const checkForceUpdate = async(): Promise<void> => {
  // 本机版本名以 PackageManager 为准，拿不到才退回 JS 包里的 package.json
  let localName = String(process.versions.app || '')
  try {
    const { info, url } = await fetchUpdateInfo()
    localName = (await getLocalVersionName()) || localName
    const minVersion = String(info.minSupportedVersion)
    const localCodeRaw = await getLocalVersionCode()
    const localCode = normalizeVersionCode(localCodeRaw)
    const remoteMinCode = normalizeVersionCode(Number(info.minVersionCode) || 0)
    const remoteLatestCode = normalizeVersionCode(Number(info.versionCode) || 0)

    const hasMinName = minVersion !== '' && minVersion !== 'undefined' && minVersion !== 'null'
    // 版本名低于云端最低要求 → 必须拦（旧的 update.json 只有 minSupportedVersion，没有 minVersionCode，
    // 只看 code 会把这类强更彻底漏掉，这就是之前「强更像丢了」的根因）
    const nameSaysOld = localName !== '' && hasMinName && compareVersion(localName, minVersion) < 0
    const nameClearlyNewer = localName !== '' && hasMinName && compareVersion(localName, minVersion) > 0
    const codeSaysOld = localCode > 0 && remoteMinCode > 0 && localCode < remoteMinCode
    // 版本名明显比云端最低要求新（例如本机 Aurora-13，云端只要求 1.9-Aurora）时，
    // 只有整型 code 落后两档以上才认定落队 —— 这一档余量专门吃掉 ABI 后缀/读数错配造成的误封。
    const blocked = nameSaysOld || (nameClearlyNewer ? (codeSaysOld && remoteMinCode - localCode >= 2) : codeSaysOld)

    const latestIsNewer = (remoteLatestCode > 0 && localCode > 0 && remoteLatestCode > localCode) ||
      (info.latestVersion ? compareVersion(String(info.latestVersion), localName) > 0 : false)

    guardActions.setInfo({
      status: blocked ? 'blocked' : 'ok',
      minVersion,
      latestVersion: info.latestVersion && latestIsNewer ? String(info.latestVersion) : '',
      message: info.message ?? '',
      downloadUrl: info.downloadUrl ?? UPDATE_DOWNLOAD_URL,
      localVersion: localName,
      localCode,
      remoteMinCode,
      remoteLatestCode,
      checkedAt: Date.now(),
    })
    writeDiag(`check ok local=${localName}(${localCodeRaw}->${localCode}) remoteMin=${minVersion}(${remoteMinCode}) remoteLatest=${String(info.latestVersion ?? '')}(${remoteLatestCode}) nameSaysOld=${nameSaysOld} codeSaysOld=${codeSaysOld} blocked=${blocked} src=${url}`)
    if (blocked) scheduleRetry()
  } catch (err) {
    // 断网 / 源不可达兜底：允许进入，联网后重试
    writeDiag(`check fail local=${localName}(${await getLocalVersionCode()}) err=${(err as Error)?.message ?? 'unknown'}`)
    if (guardState.status !== 'blocked') {
      guardActions.setInfo({ status: 'offline', localVersion: localName, checkedAt: Date.now() })
    }
    scheduleRetry()
  }
}

/** App 启动 + 前后台切换时触发校验（只更新状态，不再主动弹窗） */
export const startForceUpdateGuard = () => {
  if (started) return
  started = true
  void checkForceUpdate()
  AppState.addEventListener('change', (nextState) => {
    if (nextState === 'active') void checkForceUpdate()
  })
}
