// 卡密黑名单（云端 GitHub 文件，只存卡密的 SHA-256 哈希，不存明文）
// 多源并发，取 updatedAt 最新的一份：
//   1. GitHub API（vnd.github.raw）：不经 CDN，改完立刻能读到（未登录每小时 60 次，足够激活用）
//   2. raw / gh-proxy / statically：一般 1~2 分钟内同步
//   3. jsDelivr：缓存最久，仅兜底
export const BLACKLIST_OWNER = 'Yieyuqwqs'
export const BLACKLIST_REPO = 'Yieyu-music'
export const BLACKLIST_BRANCH = 'main'
export const BLACKLIST_FILE = 'blacklist.json'

const RAW_PATH = `${BLACKLIST_OWNER}/${BLACKLIST_REPO}/${BLACKLIST_BRANCH}/${BLACKLIST_FILE}`

export interface BlacklistSource {
  url: string
  headers?: Record<string, string>
}

export const BLACKLIST_SOURCES: BlacklistSource[] = [
  {
    // 实时源（无 CDN 缓存）
    url: `https://api.github.com/repos/${BLACKLIST_OWNER}/${BLACKLIST_REPO}/contents/${BLACKLIST_FILE}?ref=${BLACKLIST_BRANCH}`,
    headers: { Accept: 'application/vnd.github.raw' },
  },
  { url: `https://raw.githubusercontent.com/${RAW_PATH}` },
  { url: `https://gh-proxy.com/https://raw.githubusercontent.com/${RAW_PATH}` },
  { url: `https://cdn.statically.io/gh/${BLACKLIST_OWNER}/${BLACKLIST_REPO}/${BLACKLIST_BRANCH}/${BLACKLIST_FILE}` },
  { url: `https://cdn.jsdelivr.net/gh/${BLACKLIST_OWNER}/${BLACKLIST_REPO}@${BLACKLIST_BRANCH}/${BLACKLIST_FILE}` },
  { url: `https://fastly.jsdelivr.net/gh/${BLACKLIST_OWNER}/${BLACKLIST_REPO}@${BLACKLIST_BRANCH}/${BLACKLIST_FILE}` },
]

/** 兼容旧引用 */
export const BLACKLIST_URLS = BLACKLIST_SOURCES.map(item => item.url)
