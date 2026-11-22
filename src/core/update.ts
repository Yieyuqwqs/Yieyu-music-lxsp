import { APP_PROVIDER_NAME } from '@/config/constant'
import { downloadFile, temporaryDirectoryPath } from '@/utils/fs'
import { getSupportedAbis, installApk } from '@/utils/nativeModules/utils'
import { confirmDialog, toast } from '@/utils/tools'

const OWNER = 'Yieyuqwqs'
const REPO = 'Yieyu-music'

interface Asset {
  name: string
  browser_download_url: string
}

const pickAsset = async(assets: Asset[]): Promise<Asset | undefined> => {
  let abi = ''
  try {
    const abis = await getSupportedAbis()
    abi = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'].find(item => abis.includes(item)) ?? ''
  } catch {}
  return (abi ? assets.find(item => item.name.includes(abi)) : undefined) ??
    assets.find(item => item.name.includes('universal')) ??
    assets[0]
}

/**
 * 检查并安装自己仓库 Release 上的最新 APK
 */
export const checkAndInstallUpdate = async() => {
  toast(global.i18n.t('update_checking'))
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'Yieyu-music' },
  })
  if (!res.ok) throw new Error(global.i18n.t('update_check_failed'))
  const data = await res.json()
  const asset = await pickAsset((data.assets ?? []) as Asset[])
  if (!asset) throw new Error(global.i18n.t('update_check_failed'))
  const isOk = await confirmDialog({
    message: global.i18n.t('update_confirm', { name: asset.name }),
    confirmButtonText: global.i18n.t('update_install_btn'),
  })
  if (!isOk) return
  toast(global.i18n.t('update_downloading'), 'long')
  const savePath = `${temporaryDirectoryPath}/lxmusic-update.apk`
  const { promise } = downloadFile(asset.browser_download_url, savePath, {})
  await promise
  await installApk(savePath, APP_PROVIDER_NAME)
}
