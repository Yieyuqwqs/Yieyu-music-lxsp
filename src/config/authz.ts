// 授权体系配置（云端白名单 + 本机强指纹）
//
// 数据全放在公开仓库的 JSON 里，所以文件内容本身不能是「谁被授权」的明文：
//   whitelist.json   { version, updatedAt, devices: [{ k, exp, at }] }
//   blacklist.json   { version, updatedAt, keys: [k, ...] }
// 其中 k = HMAC(AUTHZ_SECRET, "yieyu-authz|v1|dev=" + 设备码)，只有管理端和客户端能算出来。
export const AUTHZ_OWNER = 'Yieyuqwqs'
// ⚠️ 必须是公开仓库：客户端是匿名拉取，私有仓库的 raw 永远 404（旧版黑名单就是这么静默失效的）。
// 管理和写名单都在这个仓库：Yieyu-music-lxsp（public）。
export const AUTHZ_REPO = 'Yieyu-music-lxsp'
export const AUTHZ_BRANCH = 'main'
export const AUTHZ_WHITELIST_FILE = 'whitelist.json'
export const AUTHZ_BLACKLIST_FILE = 'blacklist.json'

export interface AuthzSource {
  url: string
  headers?: Record<string, string>
}

/** 额外只读镜像仓库（同一个文件可以同时存在于多个公开仓库） */
const MIRROR_REPOS = ['Yieyu-Update']

/** 一个文件的下载源（多源并发，取 updatedAt 最新的一份） */
export const authzSources = (file: string): AuthzSource[] => {
  const rawPath = `${AUTHZ_OWNER}/${AUTHZ_REPO}/${AUTHZ_BRANCH}/${file}`
  const mirrorSources: AuthzSource[] = MIRROR_REPOS.map(repo => ({
    url: `https://raw.githubusercontent.com/${AUTHZ_OWNER}/${repo}/${AUTHZ_BRANCH}/${file}`,
  }))
  return [
    // 实时源：GitHub API 直读，改完 1~2 秒内就能读到（未登录每小时 60 次，激活场景足够）
    {
      url: `https://api.github.com/repos/${AUTHZ_OWNER}/${AUTHZ_REPO}/contents/${file}?ref=${AUTHZ_BRANCH}`,
      headers: { Accept: 'application/vnd.github.raw' },
    },
    { url: `https://raw.githubusercontent.com/${rawPath}` },
    { url: `https://gh-proxy.com/https://raw.githubusercontent.com/${rawPath}` },
    { url: `https://cdn.statically.io/gh/${AUTHZ_OWNER}/${AUTHZ_REPO}/${AUTHZ_BRANCH}/${file}` },
    { url: `https://cdn.jsdelivr.net/gh/${AUTHZ_OWNER}/${AUTHZ_REPO}@${AUTHZ_BRANCH}/${file}` },
    ...mirrorSources,
  ]
}

/** 单个源的超时 */
export const AUTHZ_SOURCE_TIMEOUT = 3000
/** 一次云端同步的总超时（超过就先用缓存，绝不卡住启动） */
export const AUTHZ_SYNC_TIMEOUT = 4000
/** 运行期云端复查间隔 */
export const AUTHZ_REFRESH_INTERVAL = 10 * 60 * 1000
/** 允许的时钟回拨容差（防 NTP 校正误判） */
export const AUTHZ_CLOCK_TOLERANCE = 10 * 60 * 1000
/** 迁移码在本机的「已用过」记录条数上限 */
export const AUTHZ_USED_MIGRATION_LIMIT = 50
