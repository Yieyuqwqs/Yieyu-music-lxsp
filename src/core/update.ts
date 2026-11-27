// 「设置 → 软件更新」：检查公开发布的 APK 并直接下载安装
//
// 以前的实现有两个致命点（正是这次卡死的原因）：
//   1. 请求的是私有仓库 Yieyu-music 的 releases/latest —— 匿名一定 404，国内还会挂很久；
//   2. fetch 没有超时，界面就永远停在「检查更新中…」。
// 现在：多镜像并发 + 每个请求硬超时 + 下载走国内加速前缀（见 utils/ghMirror）。
import { APP_PROVIDER_NAME } from '@/config/constant'
import { getInstalledVersionName } from '@/utils/installedVersion'
import { compareVersion } from '@/utils/versionCompare'
import { getLatestRelease, downloadApk } from '@/utils/version'
import { installApk } from '@/utils/nativeModules/utils'
import { confirmDialog, toast } from '@/utils/tools'
import { ghDownloadCandidates } from '@/utils/ghMirror'

const t = (key: string, fallback: string) => global.i18n?.t(key) ?? fallback

/**
 * 检查并安装公开 Release 上的最新 APK（不依赖任何私有仓库）
 */
export const checkAndInstallUpdate = async() => {
  toast(t('update_checking', '正在检查更新…'))

  // 1. 找最新 Release（内部已多镜像并发 + 8 秒硬超时，失败会抛错，不会挂住）
  const release = await getLatestRelease()

  // 2. 本机已经不比它旧就不用下
  let localVersion = ''
  try {
    localVersion = (await getInstalledVersionName()) || ''
  } catch {}
  if (localVersion && release.version && compareVersion(localVersion, release.version) >= 0) {
    toast(`已是最新版本（v${localVersion}）`, 'long')
    return
  }

  // 3. 确认 → 下载（加速地址依次兜底）→ 拉起安装
  const isOk = await confirmDialog({
    message: t('update_confirm', `发现新版本 v${release.version}（${release.asset.name}），是否现在更新？`),
    confirmButtonText: t('update_install_btn', '立即更新'),
  })
  if (!isOk) return

  toast(t('update_downloading', '正在下载安装包…'), 'long')
  const savePath = await downloadApk([release.asset.url], () => {})
  await installApk(savePath, APP_PROVIDER_NAME)
}

/** 给「关于」页诊断用：返回将要下载的加速候选（不发起请求） */
export const previewDownloadMirrors = async() => {
  const release = await getLatestRelease()
  return ghDownloadCandidates(release.asset.url)
}
