import { compareVersion } from '@/utils/versionCompare'
import { getInstalledVersionName } from '@/utils/installedVersion'
import { downloadNewVersion, getVersionInfo } from '@/utils/version'
import versionActions from '@/store/version/action'
import versionState, { type InitState } from '@/store/version/state'
import { getIgnoreVersion, getIgnoreVersionFailTipTime, saveIgnoreVersion, saveIgnoreVersionFailTipTime } from '@/utils/data'
import { showVersionModal } from '@/navigation'
import { Navigation } from 'react-native-navigation'
import { toast } from '@/utils/tools'

/** 一次检查的总时限：到点必须给出结果，绝不让界面停在「检查中…」 */
const CHECK_DEADLINE = 15000

let checking = false

export const showModal = () => {
  if (versionState.showModal) return
  versionActions.setVisibleModal(true)
  showVersionModal()
}

export const hideModal = (componentId: string) => {
  if (!versionState.showModal) return
  versionActions.setVisibleModal(false)
  void Navigation.dismissOverlay(componentId)
}

const withDeadline = <T>(promise: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error('检查更新超时')) }, ms)
  promise.then(
    value => { clearTimeout(timer); resolve(value) },
    error => { clearTimeout(timer); reject(error) },
  )
})

const runCheck = async(silent: boolean) => {
  let versionInfo: InitState['versionInfo'] = { ...versionState.versionInfo }
  // 每轮重新判定，别把上一轮的「已是最新 / 云端滞后」带进来
  versionInfo.isLatest = false
  versionInfo.remoteVersion = undefined
  // 本机版本以 PackageManager 为准：JS 包里的 package.json 可能与实际安装的 APK 不一致
  const localVersion = await getInstalledVersionName()
  if (localVersion) versionInfo.version = localVersion
  try {
    const { version, desc, history } = await getVersionInfo()
    versionInfo.newVersion = {
      version,
      desc,
      history,
    }
  } catch (err) {
    versionInfo.newVersion = {
      version: '0.0.0',
      desc: '',
      history: [],
    }
  }
  if (versionInfo.newVersion.version == '0.0.0') {
    versionInfo.isUnknown = true
    versionInfo.status = 'error'
  } else {
    versionInfo.status = 'idle'
    versionInfo.isUnknown = false
    const cmp = compareVersion(versionInfo.version, versionInfo.newVersion.version)
    if (cmp != -1) {
      versionInfo.isLatest = true
      if (cmp == 1) {
        // 云端元数据比本机还旧（镜像缓存滞后 / 清单回滚）。
        // 展示层的版本号必须夹回本机版本，否则就是「装着 Aurora-63 却显示 Aurora」；
        // 旧值留在 remoteVersion 里，只用来提示"云端数据滞后"。
        versionInfo.remoteVersion = versionInfo.newVersion.version
        versionInfo.newVersion.version = versionInfo.version
      }
    }
  }

  versionActions.setVersionInfo(versionInfo)

  // 启动时静默校验：只更新状态，绝不弹窗（降级误报就是从这里来的）
  if (!versionInfo.isLatest && !silent) {
    if (versionInfo.isUnknown) {
      const time = await getIgnoreVersionFailTipTime()
      if (Date.now() - time < 7 * 86400000) return
      saveIgnoreVersionFailTipTime(Date.now())
      toast(global.i18n.t('version_tip_unknown'))
    } else if (versionInfo.newVersion.version != await getIgnoreVersion()) {
      showModal()
    }
  }
}

export const checkUpdate = async(silent = false) => {
  // 防重入：连点「重新检查」不会叠出一堆并发请求
  if (checking) return
  checking = true
  versionActions.setVersionInfo({ status: 'checking' })
  try {
    await withDeadline(runCheck(silent), CHECK_DEADLINE)
  } catch (error) {
    // 超时 / 异常兜底：状态必须落下来，按钮才能继续点
    const versionInfo = { ...versionState.versionInfo }
    versionInfo.status = 'error'
    versionInfo.isUnknown = true
    versionInfo.isLatest = false
    versionActions.setVersionInfo(versionInfo)
    console.warn('[version] 检查更新失败：', (error as Error)?.message)
    if (!silent) toast('检查更新超时，请检查网络后重试', 'long')
  } finally {
    checking = false
  }
}

/**
 * 下载更新包并拉起安装。
 * @param targetVersion 强更场景由云端 guard.latestVersion 指定；普通更新用云端最新版本
 */
export const downloadUpdate = (targetVersion?: string) => {
  const version = targetVersion || versionState.versionInfo.newVersion?.version
  if (!version) {
    toast('还没有拿到云端版本号，请点「重新检查」', 'long')
    return
  }
  versionActions.setVersionInfo({ status: 'downloading' })
  versionActions.setProgress({ total: 0, current: 0 })

  downloadNewVersion(version, (total: number, current: number) => {
    versionActions.setProgress({ total, current })
  }).then(() => {
    versionActions.setVersionInfo({ status: 'downloaded' })
  }).catch((error: Error) => {
    versionActions.setVersionInfo({ status: 'error' })
    toast('下载失败：' + (error?.message ?? '请检查网络') + '，可再试一次', 'long')
  })
}


export const setIgnoreVersion = (version: InitState['ignoreVersion']) => {
  versionActions.setIgnoreVersion(version)
  saveIgnoreVersion(version)
}
