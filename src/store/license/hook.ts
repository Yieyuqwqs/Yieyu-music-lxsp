import { useEffect, useState } from 'react'
import state, { type InitState } from './state'
import { statusText } from '@/core/authz/protocol'

export const useLicenseInfo = () => {
  const [info, setInfo] = useState(state)

  useEffect(() => {
    global.state_event.on('licenseInfoUpdated', setInfo)
    return () => {
      global.state_event.off('licenseInfoUpdated', setInfo)
    }
  }, [])

  return info
}

/** 只有解锁成功后才是真·会员（锁屏/重开都会掉回待验证） */
export const isProInfo = (info: InitState) => info.status === 'active'

/** 是否已解锁会员功能 */
export const useIsPro = () => isProInfo(useLicenseInfo())

/** 状态文案：状态 + 剩余天数 */
export const vipStatusText = (info: InitState): string => {
  if (info.status === 'active') {
    if (info.daysLeft == null) return '已授权 · 永久有效'
    if (info.daysLeft <= 0) return '已授权 · 今日到期'
    return `已授权 · 剩余 ${info.daysLeft} 天`
  }
  return statusText(info.status)
}
