export type LicenseStatus = 'none' | 'active' | 'expired' | 'tampered' | 'banned'

export interface LicenseRecord {
  /** 卡密的 sha256（用于本机黑名单比对） */
  cardHash?: string
  /** 展示用的卡密掩码 */
  cardMasked: string
  /** 到期时间（ISO），null = 永久 */
  expiresAt: string | null
  activatedAt: string
}

export interface InitState {
  deviceCode: string
  status: LicenseStatus
  message: string
  record: LicenseRecord | null
  /** 剩余天数（永久为 null），用于 UI 显示 */
  daysLeft: number | null
  /** 历史最大系统时间（防时间回拨） */
  maxSeenTime: number
}

const state: InitState = {
  deviceCode: '',
  status: 'none',
  message: '未激活',
  record: null,
  daysLeft: null,
  maxSeenTime: 0,
}

export default state
