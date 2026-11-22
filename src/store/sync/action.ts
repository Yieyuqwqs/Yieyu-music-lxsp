import state from './state'
import { patchState, registerDomain } from '@/core-bridge/state'


const sync = () => {
  patchState('sync', { status: { ...state.status }, serverName: state.serverName, type: state.type, syncModeComponentId: state.syncModeComponentId })
}

const actions = {
  setStatus(info: LX.Sync.Status) {
    state.status.status = info.status
    state.status.message = info.message

    global.state_event.syncStatusUpdated({ ...state.status })
  },
  setMessage(message: LX.Sync.Status['message']) {
    state.status.message = message

    global.state_event.syncStatusUpdated({ ...state.status })
  },
  setServerInfo(name: string, type: keyof LX.Sync.ModeTypes) {
    state.serverName = name
    state.type = type
  },
  setSyncModeComponentId(id: string) {
    state.syncModeComponentId = id
  },
}

// M2：任何 action 执行完，把该域快照写进 C++ 真源（镜像期）
const wrapped = Object.fromEntries(Object.entries(actions).map(([key, fn]) => [key, (...args: any[]) => {
  const result = (fn as (...a: any[]) => any)(...args)
  sync()
  return result
}])) as typeof actions
export default wrapped

// M3：同步状态回灌
registerDomain('sync', snapshot => {
  if ('status' in snapshot) {
    Object.assign(state.status, snapshot.status as typeof state.status)
    global.state_event.syncStatusUpdated({ ...state.status })
  }
  if ('serverName' in snapshot) state.serverName = snapshot.serverName as string
  if ('type' in snapshot) state.type = snapshot.type as typeof state.type
  if ('syncModeComponentId' in snapshot) state.syncModeComponentId = snapshot.syncModeComponentId as string
})
