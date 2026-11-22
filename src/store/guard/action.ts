import state, { type InitState } from './state'
import { registerDomain, pushState } from '@/core-bridge/state'

// M3-2：guard 是非输入类状态（网络/服务端结果）→ **单源在 C++**：
// action 只写 C++，本地缓存完全由事件回灌驱动（核心不可用时才本地兜底）。
registerDomain('guard', snapshot => {
  Object.assign(state, snapshot as Partial<InitState>)
  global.state_event.guardUpdated({ ...state })
})

export default {
  setInfo(info: Partial<InitState>) {
    pushState('guard', { ...info }, () => {
      Object.assign(state, info)
      global.state_event.guardUpdated({ ...state })
    })
  },
}
