export type GuardStatus = 'idle' | 'checking' | 'blocked' | 'offline' | 'ok'

export interface InitState {
  status: GuardStatus
  /** 云端要求的最低版本名 */
  minVersion: string
  /** 云端最新版本名（只有确实比本机新时才填） */
  latestVersion: string
  /** 提示文案（云端可下发） */
  message: string
  /** 下载页地址 */
  downloadUrl: string
  /** 本机版本名（诊断用） */
  localVersion: string
  /** 本机整型 versionCode（已按 ABI 折算） */
  localCode: number
  /** 云端最低整型 versionCode */
  remoteMinCode: number
  /** 云端最新整型 versionCode */
  remoteLatestCode: number
  checkedAt: number
}

const state: InitState = {
  status: 'idle',
  minVersion: '',
  latestVersion: '',
  message: '',
  downloadUrl: '',
  localVersion: '',
  localCode: 0,
  remoteMinCode: 0,
  remoteLatestCode: 0,
  checkedAt: 0,
}

export default state
