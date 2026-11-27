import { type LicenseStatus } from '@/core/authz/protocol'

export type { LicenseStatus }

export interface InitState {
  /** 本机设备码（强指纹派生，发给管理员） */
  deviceCode: string
  status: LicenseStatus
  /** 当前状态说明（给用户看的一句话） */
  message: string
  /** 到期时间 ISO（永久为 null） */
  exp: string | null
  /** 剩余天数（永久为 null） */
  daysLeft: number | null
  /** 本机是否已经绑定过指纹（有 Keystore 密文） */
  hasToken: boolean
  /** 指纹硬件是否可用 */
  biometricAvailable: boolean
  /** 最近一次云端清单是否是新鲜拉到的 */
  cloudOnline: boolean
  /** 历史最大系统时间（防时间回拨） */
  maxSeenTime: number
}

const state: InitState = {
  deviceCode: '',
  status: 'boot',
  message: '正在检查授权…',
  exp: null,
  daysLeft: null,
  hasToken: false,
  biometricAvailable: false,
  cloudOnline: false,
  maxSeenTime: 0,
}

export default state
