// 强制更新守卫配置
// 主仓库 Yieyu-music 是私有的（源码 / 发卡密钥不能公开），匿名 raw 一定 404，
// jsDelivr 只会回旧缓存 —— 所以强更清单单独放公开只读仓库 Yieyu-Update，只放 update.json。
export const UPDATE_GUARD_OWNER = 'Yieyuqwqs'
export const UPDATE_GUARD_REPO = 'Yieyu-Update'
export const UPDATE_GUARD_BRANCH = 'main'
export const UPDATE_GUARD_FILE = 'update.json'

// 主仓库只作为 historical fallback：万一 Yieyu-Update 挂了 / 限流，还能吃旧地址
const PRIVATE_REPO = 'Yieyu-music'

export const UPDATE_GUARD_URLS = [
  // 公开清单（首选，匿名可读，改完立即生效）
  `https://raw.githubusercontent.com/${UPDATE_GUARD_OWNER}/${UPDATE_GUARD_REPO}/${UPDATE_GUARD_BRANCH}/${UPDATE_GUARD_FILE}`,
  `https://cdn.jsdelivr.net/gh/${UPDATE_GUARD_OWNER}/${UPDATE_GUARD_REPO}@${UPDATE_GUARD_BRANCH}/${UPDATE_GUARD_FILE}`,
  `https://fastly.jsdelivr.net/gh/${UPDATE_GUARD_OWNER}/${UPDATE_GUARD_REPO}@${UPDATE_GUARD_BRANCH}/${UPDATE_GUARD_FILE}`,
  // 旧地址兜底（私有仓库 → 正常是 404 / 旧缓存，不要当地址失效就 panic）
  `https://raw.githubusercontent.com/${UPDATE_GUARD_OWNER}/${PRIVATE_REPO}/${UPDATE_GUARD_BRANCH}/${UPDATE_GUARD_FILE}`,
  `https://cdn.jsdelivr.net/gh/${UPDATE_GUARD_OWNER}/${PRIVATE_REPO}@${UPDATE_GUARD_BRANCH}/${UPDATE_GUARD_FILE}`,
  `https://fastly.jsdelivr.net/gh/${UPDATE_GUARD_OWNER}/${PRIVATE_REPO}@${UPDATE_GUARD_BRANCH}/${UPDATE_GUARD_FILE}`,
]

/** 下载页（没有具体版号时用它）：必须指向公开仓库的 Release，私有仓库的下载页匿名打不开 */
export const UPDATE_DOWNLOAD_URL = `https://github.com/${UPDATE_GUARD_OWNER}/${UPDATE_GUARD_REPO}/releases/latest`

/** 断网重试间隔 */
export const UPDATE_RETRY_INTERVAL = 60 * 1000
