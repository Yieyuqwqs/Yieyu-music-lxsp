/**
 * 版本号比较（Yieyu 专用，稳定版方案）
 *
 * 背景：原来的 compareVer 把非数字字符逐字替换成负数后再逐段比较，
 * 导致 "1.9-Aurora-11" 反而比 "1.9-Aurora" 更小（多出来的负数段 vs 缺失段 0），
 * 于是已装最新版还会被判「可更新」，弹出降级提示。
 *
 * 这里改成显式解析：主.次.修订 + 结尾序号（Aurora-11 的 11）。
 * 判定优先级：整型 versionCode > 字符串版本号。
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 结尾序号：1.9-Aurora-11 -> 11；1.9-Aurora -> 0 */
  build: number
}

/** 解析版本号：兼容 1.9.17 / 1.9-Aurora / 1.9-Aurora-5 / v1.9.0 */
export const parseVersion = (value: string): ParsedVersion => {
  const text = String(value ?? '0').trim().replace(/^v/i, '')
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$/.exec(text)
  const major = match ? parseInt(match[1], 10) || 0 : 0
  const minor = match?.[2] ? parseInt(match[2], 10) || 0 : 0
  const patch = match?.[3] ? parseInt(match[3], 10) || 0 : 0
  const rest = match ? (match[4] || '') : text
  const trailing = /(\d+)\s*$/.exec(rest)
  const build = trailing ? parseInt(trailing[1], 10) || 0 : 0
  return { major, minor, patch, build }
}

/** 比较版本号，返回 -1 / 0 / 1（后缀里的数字也参与比较：Aurora-11 > Aurora-9 > Aurora） */
export const compareVersion = (a: string, b: string): -1 | 0 | 1 => {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const keys: (keyof ParsedVersion)[] = ['major', 'minor', 'patch', 'build']
  for (const key of keys) {
    if (pa[key] > pb[key]) return 1
    if (pa[key] < pb[key]) return -1
  }
  return 0
}

/**
 * ABI 拆分会让 versionCode 变成「主号 * 1000 + ABI 序号」（16 -> 16003）。
 * 云端 update.json 里写的是主号，这里统一折算，避免 16003 vs 16 这类错配。
 */
export const normalizeVersionCode = (code: number): number => {
  const value = Math.floor(Number(code) || 0)
  if (value <= 0) return 0
  return value >= 1000 ? Math.floor(value / 1000) : value
}
