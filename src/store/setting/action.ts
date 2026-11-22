import { updateSetting as mergeSetting } from '@/config/setting'
import state from './state'
import { patchState, registerDomain } from '@/core-bridge/state'

// M2 批 5：setting 域下沉。设置项是「真源」里最重要的一块 ——
// 它是全 App 读得最多、且必须跨进程重启保持一致的状态。
const sync = () => {
  patchState('setting', { setting: state.setting })
}

export default {
  initSetting(newSetting: LX.AppSetting) {
    state.setting = newSetting
    sync()
  },
  updateSetting(newSetting: Partial<LX.AppSetting>) {
    const result = mergeSetting(newSetting)
    state.setting = result.setting
    sync()
    global.state_event.configUpdated(result.updatedSettingKeys, result.updatedSetting)
  },
}

// M3：设置项的回灌 —— 冷启动水合与跨进程恢复都靠它。
// 注意：写路径仍是「本地即时 + 写 C++」（输入类），这里只负责把真源的变化同步回本地。
registerDomain('setting', snapshot => {
  if (!('setting' in snapshot)) return
  const next = snapshot.setting as LX.AppSetting
  const prev = state.setting
  const keys = Object.keys(next).filter(key => (prev as Record<string, unknown>)[key] !== (next as Record<string, unknown>)[key]) as Array<keyof LX.AppSetting>
  state.setting = next
  if (keys.length) global.state_event.configUpdated(keys, next)
})
