import state, { type InitState } from './state'
import { patchState, registerDomain } from '@/core-bridge/state'

let invalidateCache: (() => void) | null = null

export const bindCacheInvalidator = (fn: () => void) => {
  invalidateCache = fn
}

const emitUpdate = () => {
  invalidateCache?.()
  global.state_event.downloadListUpdated([...state.list])
}

const sync = () => {
  patchState('downloadList', { saveDir: state.saveDir })
}

const actions = {
  setList(list: InitState['list']) {
    state.list = list
    emitUpdate()
  },
  setSaveDir(dir: string) {
    if (state.saveDir == dir) return
    state.saveDir = dir
  },
  addTasks(tasks: InitState['list']) {
    if (!tasks.length) return
    state.list.push(...tasks)
    emitUpdate()
  },
  updateTask(id: string, data: Partial<LX.Download.ListItem>) {
    const target = state.list.find(t => t.id == id)
    if (!target) return
    Object.assign(target, data)
    emitUpdate()
  },
  updateTasks(ids: string[], data: Partial<LX.Download.ListItem>) {
    let updated = false
    for (const task of state.list) {
      if (!ids.includes(task.id)) continue
      Object.assign(task, data)
      updated = true
    }
    if (updated) emitUpdate()
  },
  removeTasks(ids: string[]) {
    let removed = false
    for (let index = state.list.length - 1; index > -1; index--) {
      if (!ids.includes(state.list[index].id)) continue
      state.list.splice(index, 1)
      removed = true
    }
    if (removed) emitUpdate()
  },
  clearCompleted() {
    const oldLength = state.list.length
    state.list = state.list.filter(t => t.status != 'completed')
    if (state.list.length != oldLength) emitUpdate()
  },
  getTask(id: string) {
    return state.list.find(t => t.id == id)
  },
  hasTask(id: string) {
    return state.list.some(t => t.id == id)
  },
}

// M2：任何 action 执行完，把该域快照写进 C++ 真源（镜像期）
const wrapped = Object.fromEntries(Object.entries(actions).map(([key, fn]) => [key, (...args: any[]) => {
  const result = (fn as (...a: any[]) => any)(...args)
  sync()
  return result
}])) as typeof actions
export default wrapped

// M3：下载目录回灌（任务表本身不下沉）
registerDomain('downloadList', snapshot => {
  if ('saveDir' in snapshot) state.saveDir = snapshot.saveDir as string
})
