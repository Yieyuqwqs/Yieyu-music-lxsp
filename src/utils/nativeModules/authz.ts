// 授权核原生桥（Android: cn.toside.music.authz.AuthzModule，JS 名 YieyuAuth）
//
// 这里只做「一行转调」：所有判断都在 core/authz/protocol + core/license 里，
// 原生层只负责 设备码/HMAC（C++）、指纹与 Keystore（Java）。
import { DeviceEventEmitter, NativeModules } from 'react-native'

const nativeModule = NativeModules.YieyuAuth

export const AUTHZ_SCREEN_OFF_EVENT = 'YieyuAuth:screenOff'

export const isAuthzAvailable = () => !!nativeModule

const call = <T>(name: string, ...args: any[]): Promise<T> => {
  if (!nativeModule) return Promise.reject(new Error('授权模块未加载（可能是系统版本过低或安装包损坏）'))
  const method = nativeModule[name]
  if (typeof method !== 'function') return Promise.reject(new Error(`授权模块缺少方法 ${name}`))
  return Promise.resolve(method(...args) as T)
}

/** 空串 = 授权核自检通过；非空 = 失败原因 */
export const authzSelfTest = (): Promise<string> => call<string>('selfTest')

export const getDeviceCode = (): Promise<string> => call<string>('getDeviceCode')

export const getEntryKey = (deviceCode: string): Promise<string> => call<string>('getEntryKey', deviceCode)

/** QQ 的条目键（HMAC，64 位十六进制）：公开名单里只存这个 */
export const getQqKey = (qq: string): Promise<string> => call<string>('getQqKey', qq)

/** 给文本做 HMAC（授权申请码防篡改） */
export const signText = (text: string): Promise<string> => call<string>('signText', text)

export const getBiometricState = (): Promise<{ available: boolean, message: string }> => call('getBiometricState')

export const hasToken = (): Promise<boolean> => call<boolean>('hasToken')

/** 会弹指纹；成功才落盘 */
export const storeToken = (token: string): Promise<null> => call<null>('storeToken', token)

/** 会弹指纹；返回令牌明文（只许放内存） */
export const readToken = (): Promise<string> => call<string>('readToken')

export const clearToken = (): Promise<null> => call<null>('clearToken')

/** 老设备：expMs = 0 表示永久 */
export const exportMigration = (expMs: number): Promise<string> => call<string>('exportMigration', expMs)

/** 新设备：只验签，不弹指纹 */
export interface MigrationResult {
  expMs: number
  issuedSec: number
  srcTag: string
  nonce: number
}
export const importMigration = (code: string): Promise<MigrationResult> => call<MigrationResult>('importMigration', code)

/** 锁屏事件（ACTION_SCREEN_OFF）→ 清内存令牌 */
export const onScreenOff = (handler: () => void): (() => void) => {
  const subscription = DeviceEventEmitter.addListener(AUTHZ_SCREEN_OFF_EVENT, handler)
  return () => { subscription.remove() }
}

export default {
  isAuthzAvailable,
  authzSelfTest,
  getDeviceCode,
  getEntryKey,
  getQqKey,
  signText,
  getBiometricState,
  hasToken,
  storeToken,
  readToken,
  clearToken,
  exportMigration,
  importMigration,
  onScreenOff,
}
