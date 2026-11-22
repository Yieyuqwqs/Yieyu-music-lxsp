import state, { type InitState } from './state'
import { patchState, registerDomain } from '@/core-bridge/state'
import { type COMPONENT_IDS } from '@/config/constant'


const sync = () => {
  patchState('common', { fontSize: state.fontSize, statusbarHeight: state.statusbarHeight, componentIds: { ...state.componentIds }, navActiveId: state.navActiveId, lastNavActiveId: state.lastNavActiveId, bgPic: state.bgPic, sourceNames: state.sourceNames })
}

const actions = {
  setFontSize(size: number) {
    state.fontSize = size
    global.state_event.fontSizeUpdated(size)
  },
  setStatusbarHeight(size: number) {
    if (state.statusbarHeight == size) return
    state.statusbarHeight = size
    global.state_event.statusbarHeightUpdated(size)
  },
  setComponentId(name: COMPONENT_IDS, id: string) {
    state.componentIds[name] = id
    global.state_event.componentIdsUpdated({ ...state.componentIds })
  },
  removeComponentId(id: string) {
    const name = (Object.entries(state.componentIds) as Array<[COMPONENT_IDS, string]>).find(kv => kv[1] == id)?.[0]
    if (!name) return
    delete state.componentIds[name]
    global.state_event.componentIdsUpdated({ ...state.componentIds })
  },
  setNavActiveId(id: InitState['navActiveId']) {
    state.navActiveId = id
    if (id != 'nav_setting') state.lastNavActiveId = id
    global.state_event.navActiveIdUpdated(id)
  },
  setLastNavActiveId(id: InitState['navActiveId']) {
    state.lastNavActiveId = id
  },
  setBgPic(pic: string | null) {
    state.bgPic = pic
    global.state_event.bgPicUpdated(pic)
  },
  setSourceNames(names: InitState['sourceNames']) {
    state.sourceNames = names
    global.state_event.sourceNamesUpdated(names)
  },
}

// M2：任何 action 执行完，把该域快照写进 C++ 真源（镜像期）
const wrapped = Object.fromEntries(Object.entries(actions).map(([key, fn]) => [key, (...args: any[]) => {
  const result = (fn as (...a: any[]) => any)(...args)
  sync()
  return result
}])) as typeof actions
export default wrapped

// M3：事件回灌 —— C++ 里改了这些字段时，本地缓存跟着变（UI 事件照旧触发）
registerDomain('common', snapshot => {
  if ('fontSize' in snapshot) {
    state.fontSize = snapshot.fontSize as number
    global.state_event.fontSizeUpdated(state.fontSize)
  }
  if ('statusbarHeight' in snapshot) {
    state.statusbarHeight = snapshot.statusbarHeight as number
    global.state_event.statusbarHeightUpdated(state.statusbarHeight)
  }
  if ('componentIds' in snapshot) {
    state.componentIds = snapshot.componentIds as typeof state.componentIds
    global.state_event.componentIdsUpdated({ ...state.componentIds })
  }
  if ('navActiveId' in snapshot) {
    state.navActiveId = snapshot.navActiveId as typeof state.navActiveId
    global.state_event.navActiveIdUpdated(state.navActiveId)
  }
  if ('lastNavActiveId' in snapshot) state.lastNavActiveId = snapshot.lastNavActiveId as typeof state.lastNavActiveId
  if ('bgPic' in snapshot) {
    state.bgPic = snapshot.bgPic as typeof state.bgPic
    global.state_event.bgPicUpdated(state.bgPic)
  }
  if ('sourceNames' in snapshot) {
    state.sourceNames = snapshot.sourceNames as typeof state.sourceNames
    global.state_event.sourceNamesUpdated(state.sourceNames)
  }
})
