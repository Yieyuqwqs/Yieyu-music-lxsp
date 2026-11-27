/**
 * 小密钥的安全存取（Android Keystore 硬件加密）。
 *
 * 用途：管理端 GitHub PAT 这类「必须落盘、但绝不能明文」的短字符串。
 * 以前它明文躺在 AsyncStorage（`yieyu.admin.token`），应用私有目录一被读走就等于泄露。
 *
 * 降级规则（刻意写死在这里，调用方不用各写一遍）：
 *   · 原生方法不可用 / 调用失败 → 只放内存，返回 persisted:false + 原因；
 *   · 绝不允许回落到明文存储（那就等于没修）。
 */
import { NativeModules } from 'react-native'

interface SecretBridge {
  secretSet?: (name: string, value: string) => Promise<null>
  secretGet?: (name: string) => Promise<string | null>
  secretRemove?: (name: string) => Promise<null>
}

const memory = new Map<string, string>()

// 每次调用时再取：测试里可以注入假桥，也避免模块加载顺序影响
const getBridge = (): SecretBridge | undefined => (NativeModules as { YieyuAuth?: SecretBridge }).YieyuAuth

export const isSecureStoreAvailable = (): boolean => {
  const bridge = getBridge()
  return !!bridge && typeof bridge.secretSet === 'function' && typeof bridge.secretGet === 'function'
}

export interface SecretWriteResult {
  /** true = 已加密落盘；false = 只存在内存里（退出应用即失效） */
  persisted: boolean
  reason?: string
}

export const setSecret = async(name: string, value: string): Promise<SecretWriteResult> => {
  memory.set(name, value)
  if (!isSecureStoreAvailable()) {
    return { persisted: false, reason: '本机没有硬件密钥存储（YieyuAuth 不可用），令牌只保留在内存' }
  }
  try {
    await getBridge()!.secretSet!(name, value)
    return { persisted: true }
  } catch (error) {
    return { persisted: false, reason: `写入硬件密钥失败（${(error as Error)?.message ?? '未知错误'}），令牌只保留在内存` }
  }
}

export const getSecret = async(name: string): Promise<string | null> => {
  const cached = memory.get(name)
  if (cached !== undefined) return cached
  if (!isSecureStoreAvailable()) return null
  try {
    const value = await getBridge()!.secretGet!(name)
    if (typeof value === 'string' && value) {
      memory.set(name, value)
      return value
    }
    return null
  } catch (error) {
    return null
  }
}

export const removeSecret = async(name: string): Promise<void> => {
  memory.delete(name)
  const bridge = getBridge()
  if (!bridge || typeof bridge.secretRemove !== 'function') return
  try {
    await bridge.secretRemove(name)
  } catch (error) { /* 删不掉不影响使用：内存已经清空，下次写入会覆盖 */ }
}

/** 仅供测试：清空内存缓存（不影响已落盘的密文） */
export const __clearSecretMemory = (): void => { memory.clear() }
