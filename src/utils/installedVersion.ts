import { NativeModules } from 'react-native'

/**
 * 本机真实版本号。
 * 只认 PackageManager（原生 PackageManager.getPackageInfo）——process.versions.app 读的是
 * 打进 JS 包的 package.json 版本号，一旦 JS 包和 APK 版本不一致（增量热更、CI 漏改）就会
 * 出现「装的是 Aurora-12 却显示 Aurora」这种错位。
 */
const utilsBridge = NativeModules.UtilsModule as {
  getVersionName?: () => Promise<string>
  getVersionCode?: () => Promise<number>
} | undefined

const fallbackName = typeof process.versions?.app === 'string' ? process.versions.app : ''

export const getInstalledVersionName = async(): Promise<string> => {
  try {
    const name = await utilsBridge?.getVersionName?.()
    if (typeof name === 'string' && name.trim()) return name.trim()
  } catch {}
  return fallbackName
}

export const getInstalledVersionCode = async(): Promise<number> => {
  try {
    const code = await utilsBridge?.getVersionCode?.()
    if (typeof code === 'number' && code > 0) return Math.floor(code)
  } catch {}
  return 0
}

/** 把 ABI 拆分的 code（17003）折算回整型版本号（17） */
export const normalizeInstalledCode = (code: number): number => code >= 1000 ? Math.floor(code / 1000) : code

/** "1.9-Aurora-12" -> { base: "1.9", series: "Aurora", build: "12" } */
export const parseVersionName = (version: string) => {
  const parts = String(version || '').split('-').filter(Boolean)
  const build = parts.length > 2 ? parts[parts.length - 1] : ''
  return {
    base: parts[0] ?? '',
    series: parts.length > 1 ? parts[1] : '',
    build,
    // 头部徽标只用系列名 + 构建号：Aurora 12
    badge: [parts.length > 1 ? parts[1] : '', build].filter(Boolean).join(' '),
  }
}
