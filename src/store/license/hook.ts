import { useEffect, useState } from 'react'
import state, { type InitState } from './state'

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

export const isProInfo = (info: InitState) => info.status === 'active'

/** 是否已解锁会员功能 */
export const useIsPro = () => isProInfo(useLicenseInfo())

/** VIP 状态文案：剩余 X 天 / 永久有效 */
export const vipStatusText = (info: InitState): string => {
  if (info.status === 'expired') return 'VIP 状态：已到期'
  if (info.status === 'tampered') return 'VIP 状态：已失效（检测到系统时间异常）'
  if (info.status === 'banned') return 'VIP 状态：已封禁'
  if (info.status !== 'active') return 'VIP 状态：未激活'
  if (info.daysLeft == null) return 'VIP 状态：永久有效'
  if (info.daysLeft <= 0) return 'VIP 状态：今日到期'
  return `VIP 状态：剩余 ${info.daysLeft} 天`
}
