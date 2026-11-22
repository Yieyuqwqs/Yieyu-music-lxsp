import { buildActiveThemeColors } from '@/theme/themes'
import { patchState, registerDomain } from '@/core-bridge/state'
import state from './state'


const sync = () => {
  patchState('theme', { shouldUseDarkColors: state.shouldUseDarkColors })
}

const actions = {
  setTheme(theme: LX.Theme) {
    state.theme = buildActiveThemeColors(theme)
    // ThemeContext.displayName
    global.state_event.themeUpdated(state.theme)
  },
  setShouldUseDarkColors(shouldUseDarkColors: boolean) {
    if (state.shouldUseDarkColors == shouldUseDarkColors) return
    state.shouldUseDarkColors = shouldUseDarkColors
  },
}

// M2：任何 action 执行完，把该域快照写进 C++ 真源（镜像期）
const wrapped = Object.fromEntries(Object.entries(actions).map(([key, fn]) => [key, (...args: any[]) => {
  const result = (fn as (...a: any[]) => any)(...args)
  sync()
  return result
}])) as typeof actions
export default wrapped

// M3：深浅色标记回灌（主题色对象本身由 themeUpdated 事件驱动）
registerDomain('theme', snapshot => {
  if ('shouldUseDarkColors' in snapshot) state.shouldUseDarkColors = snapshot.shouldUseDarkColors as boolean
})
