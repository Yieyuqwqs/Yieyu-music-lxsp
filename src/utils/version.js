// 版本信息 / 安装包下载
//
// 三条硬约束（都是被国内网络教出来的）：
//   1. 只读「公开」仓库：私有仓库的 raw / releases 匿名一定 404（旧版就是因此永远卡在“检查中…”）。
//   2. 每个请求都有硬超时；清单优先走 api.github.com 的 contents API（实测国内最稳），
//      反代/直链只做兜底 —— 全部在 utils/ghMirror 里统一处理。
//   3. 下载地址必须带国内加速前缀（gh-proxy.com 实测可用），直连只作最后一档。
import { ghFetch, ghFetchRawText, ghDownloadCandidates } from '@/utils/ghMirror'
import { downloadFile, stopDownload, temporaryDirectoryPath } from '@/utils/fs'
import { getSupportedAbis, installApk } from '@/utils/nativeModules/utils'
import { APP_PROVIDER_NAME } from '@/config/constant'
import { compareVersion } from '@/utils/versionCompare'

const OWNER = 'Yieyuqwqs'
/** 公开更新仓库：update.json + Release APK 都在这里 */
const PUBLIC_REPO = 'Yieyu-Update'
/** 兼容：可能还存在别的公开仓库（找不到就跳过） */
const RELEASE_REPOS = [PUBLIC_REPO, 'Yieyu-music-lxsp']
const APK_NAME_PREFIX = 'Yieyu-music-mobile'
/** 清单请求超时（多候选并发，谁先返回用谁） */
const META_TIMEOUT = 6000
/** Release 请求超时 */
const RELEASE_TIMEOUT = 8000
/** Release 信息缓存 */
const RELEASE_CACHE_TTL = 5 * 60 * 1000

const abis = [
  'arm64-v8a',
  'armeabi-v7a',
  'x86_64',
  'x86',
  'universal',
]

/* ------------------------------ 清单 ------------------------------ */

const manifestUrl = `https://api.github.com/repos/${OWNER}/${PUBLIC_REPO}/contents/update.json?ref=main`
const manifestRawUrl = `https://raw.githubusercontent.com/${OWNER}/${PUBLIC_REPO}/main/update.json`

/** update.json → 统一的版本信息形状 */
const normalizeManifest = (data) => {
  if (!data || typeof data !== 'object') return null
  const version = String(data.latestVersion || data.minSupportedVersion || data.version || '').trim()
  if (!version) return null
  return {
    version,
    desc: typeof data.message === 'string' ? data.message : '',
    history: [],
    downloadUrl: typeof data.downloadUrl === 'string' ? data.downloadUrl : '',
  }
}

const readManifest = async() => {
  const text = await ghFetchRawText(manifestUrl, { timeoutMs: META_TIMEOUT })
  return normalizeManifest(JSON.parse(text))
}

/* ------------------------------ Release ------------------------------ */

const parseTagVersion = (tag) => String(tag || '').replace(/^v/i, '').trim()

const pickAsset = async(assets) => {
  let abi = ''
  try {
    const supported = await getSupportedAbis()
    abi = abis.find(item => supported.includes(item)) ?? ''
  } catch {}
  return (abi ? assets.find(item => item.name.includes(abi)) : undefined) ??
    assets.find(item => item.name.includes('universal')) ??
    assets[0]
}

const fetchLatestRelease = async(repo) => {
  const { data } = await ghFetch(`https://api.github.com/repos/${OWNER}/${repo}/releases/latest`, {
    timeoutMs: RELEASE_TIMEOUT,
    validate: data => !!data && Array.isArray(data.assets) && data.assets.length > 0,
  })
  const assets = (data.assets || []).map(item => ({
    name: String(item.name || ''),
    url: String(item.browser_download_url || ''),
  }))
  const asset = await pickAsset(assets)
  if (!asset || !asset.url) throw new Error('该 Release 没有可用的 APK')
  return {
    repo,
    tag: String(data.tag_name || ''),
    version: parseTagVersion(data.tag_name || data.name || ''),
    body: String(data.body || ''),
    htmlUrl: String(data.html_url || ''),
    asset,
    assets,
  }
}

let releaseCache = null

/** 找最新的公开 Release（多仓库并发，取版本号最大的一份；失败抛错但不会挂住） */
export const getLatestRelease = async() => {
  if (releaseCache && Date.now() - releaseCache.at < RELEASE_CACHE_TTL) return releaseCache.release

  const results = await Promise.all(RELEASE_REPOS.map(repo =>
    fetchLatestRelease(repo).then(release => release, () => null)))
  const releases = results.filter(Boolean)
  if (!releases.length) throw new Error(global.i18n?.t('update_check_failed') ?? '检查更新失败')

  releases.sort((a, b) => {
    if (a.version && b.version) {
      const cmp = compareVersion(a.version, b.version)
      if (cmp !== 0) return cmp > 0 ? -1 : 1
    }
    return RELEASE_REPOS.indexOf(a.repo) - RELEASE_REPOS.indexOf(b.repo)
  })
  const release = releases[0]
  releaseCache = { at: Date.now(), release }
  return release
}

/**
 * 版本信息：优先用公开 Release（tag + 说明，最实时），
 * 拿不到再退回 update.json（形状不同，这里归一化）。
 */
export const getVersionInfo = async() => {
  try {
    const release = await getLatestRelease()
    if (release.version) {
      return {
        version: release.version,
        desc: release.body,
        history: [],
      }
    }
  } catch (error) {
    // 继续走 update.json
  }

  let lastError = new Error('云端版本信息不可用')
  for (const url of [manifestUrl, manifestRawUrl]) {
    try {
      const text = await ghFetchRawText(url, { timeoutMs: META_TIMEOUT })
      const info = normalizeManifest(JSON.parse(text))
      if (info) return { version: info.version, desc: info.desc, history: [] }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/* ------------------------------ 下载安装 ------------------------------ */

const getTargetAbi = async() => {
  const supportedAbis = await getSupportedAbis()
  for (const abi of abis) {
    if (supportedAbis.includes(abi)) return abi
  }
  return abis[abis.length - 1]
}

const savePathOf = () => temporaryDirectoryPath + '/Yieyu-music-mobile.apk'

let downloadJobId = null
let apkSavePath
const noop = () => {}

/** 单个地址下载一次（失败/超时抛错，交给调用方换镜像） */
const downloadOnce = async(url, savePath, onDownload) => {
  if (downloadJobId) {
    stopDownload(downloadJobId)
    downloadJobId = null
  }
  const { jobId, promise } = downloadFile(url, savePath, {
    progressInterval: 500,
    connectionTimeout: 15000,
    readTimeout: 30000,
    begin({ statusCode, contentLength }) {
      onDownload(contentLength, 0)
    },
    progress({ contentLength, bytesWritten }) {
      onDownload(contentLength, bytesWritten)
    },
  })
  downloadJobId = jobId
  try {
    await promise
  } finally {
    downloadJobId = null
  }
}

/**
 * 按「加速反代 → 镜像域名 → 直连」顺序依次尝试，任一成功即返回本地路径。
 * @param {string[]} urls 原始 GitHub 下载地址（会各自展开成加速候选）
 */
export const downloadApk = async(urls, onDownload = noop) => {
  const candidates = []
  for (const url of urls) {
    for (const candidate of ghDownloadCandidates(url)) {
      if (!candidates.includes(candidate)) candidates.push(candidate)
    }
  }
  const savePath = savePathOf()
  let lastError = new Error('下载失败')
  for (const url of candidates) {
    try {
      await downloadOnce(url, savePath, onDownload)
      apkSavePath = savePath
      return savePath
    } catch (error) {
      lastError = error
      console.warn('[update] 下载失败，换下一个加速地址：', url, error?.message)
    }
  }
  throw lastError
}

export const downloadNewVersion = async(version, onDownload = noop) => {
  const abi = await getTargetAbi()
  const urls = RELEASE_REPOS.map(repo =>
    `https://github.com/${OWNER}/${repo}/releases/download/v${version}/${APK_NAME_PREFIX}-v${version}-${abi}.apk`)
  await downloadApk(urls, onDownload)
  return updateApp()
}

export const updateApp = async() => {
  if (!apkSavePath) throw new Error('apk Save Path is null')
  await installApk(apkSavePath, APP_PROVIDER_NAME)
}
