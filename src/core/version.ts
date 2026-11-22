import { compareVersion } from '@/utils/versionCompare'
import { getInstalledVersionName } from '@/utils/installedVersion'
import { downloadNewVersion, getVersionInfo } from '@/utils/version'
import versionActions from '@/store/version/action'
import versionState, { type InitState } from '@/store/version/state'
import { getIgnoreVersion, getIgnoreVersionFailTipTime, saveIgnoreVersion, saveIgnoreVersionFailTipTime } from '@/utils/data'
import { showVersionModal } from '@/navigation'
import { Navigation } from 'react-native-navigation'
import { toast } from '@/utils/tools'

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

export const checkUpdate = async(silent = false) => {
  versionActions.setVersionInfo({ status: 'checking' })
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
        // 云端元数据比本机还旧（私有仓库 → raw 404 → jsDelivr 旧缓存）。
        // 展示层的版本号必须夹回本机版本，否则就是「装着 Aurora-12 却显示 Aurora」；
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

export const downloadUpdate = () => {
  versionActions.setVersionInfo({ status: 'downloading' })
  versionActions.setProgress({ total: 0, current: 0 })

  downloadNewVersion(versionState.versionInfo.newVersion!.version, (total: number, current: number) => {
    versionActions.setProgress({ total, current })
  }).then(() => {
    versionActions.setVersionInfo({ status: 'downloaded' })
  }).catch(() => {
    versionActions.setVersionInfo({ status: 'error' })
  })
}


export const setIgnoreVersion = (version: InitState['ignoreVersion']) => {
  versionActions.setIgnoreVersion(version)
  saveIgnoreVersion(version)
}
