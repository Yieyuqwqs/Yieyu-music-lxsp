// 授权体系配置（云端白名单 + 本机强指纹）
//
// 名单文件必须放在**公开**仓库：客户端是匿名读取，私有仓库的 raw / API 都会 404。
// 源码仓库（Yieyu-music-lxsp）是私有的，所以名单放公开更新仓库 Yieyu-Update。
//
// 文件内容本身不是「谁被授权」的明文：
//   whitelist.json   { version, updatedAt, devices: [{ k, exp, at }] }
//   blacklist.json   { version, updatedAt, keys: [k, ...] }
// 其中 k = HMAC(AUTHZ_SECRET, "yieyu-authz|v1|dev=" + 设备码)，只有管理端和客户端能算出来。
import { ghUrlCandidates } from '@/utils/ghMirror'

export const AUTHZ_OWNER = 'Yieyuqwqs'
/** 公开更新仓库（放 update.json / APK / 授权名单） */
export const AUTHZ_REPO = 'Yieyu-Update'
export const AUTHZ_BRANCH = 'main'
export const AUTHZ_WHITELIST_FILE = 'whitelist.json'
export const AUTHZ_BLACKLIST_FILE = 'blacklist.json'

export interface AuthzSource {
  url: string
  headers?: Record<string, string>
}

/** 仓库文件的读取地址（contents API，带 ?ref=；实测国内最稳） */
export const authzFileUrl = (file: string): string =>
  `https://api.github.com/repos/${AUTHZ_OWNER}/${AUTHZ_REPO}/contents/${file}?ref=${AUTHZ_BRANCH}`

/** 直链形式（反代/镜像兜底用） */
export const authzRawUrl = (file: string): string =>
  `https://raw.githubusercontent.com/${AUTHZ_OWNER}/${AUTHZ_REPO}/${AUTHZ_BRANCH}/${file}`

/** 兼容旧调用：把一份文件展开成所有候选地址（并发赛跑交给 ghMirror） */
export const authzSources = (file: string): AuthzSource[] => {
  const list: AuthzSource[] = []
  for (const url of ghUrlCandidates(authzFileUrl(file))) {
    list.push({ url, headers: { Accept: 'application/vnd.github.raw' } })
  }
  for (const url of ghUrlCandidates(authzRawUrl(file))) {
    if (!list.some(item => item.url === url)) list.push({ url })
  }
  return list
}

/** 单次请求的超时（毫秒） */
export const AUTHZ_SOURCE_TIMEOUT = 6000
/** 一次云端同步的总超时（超过就先用缓存，绝不卡住启动） */
export const AUTHZ_SYNC_TIMEOUT = 8000
/** 运行期云端复查间隔 */
export const AUTHZ_REFRESH_INTERVAL = 10 * 60 * 1000
/** 允许的时钟回拨容差（防 NTP 校正误判） */
export const AUTHZ_CLOCK_TOLERANCE = 10 * 60 * 1000
/** 迁移码在本机的「已用过」记录条数上限 */
export const AUTHZ_USED_MIGRATION_LIMIT = 50
