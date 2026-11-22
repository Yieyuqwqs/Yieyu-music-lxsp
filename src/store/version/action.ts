import state, { type InitState } from './state'
import { registerDomain, pushState } from '@/core-bridge/state'

// M3-2：version 与 guard 一样是外部驱动状态 → 单源在 C++，本地由事件回灌。
registerDomain('version', snapshot => {
  if ('versionInfo' in snapshot) {
    Object.assign(state.versionInfo, snapshot.versionInfo as InitState['versionInfo'])
    global.state_event.versionInfoUpdated({ ...state.versionInfo })
  }
  if ('ignoreVersion' in snapshot) {
    state.ignoreVersion = snapshot.ignoreVersion as InitState['ignoreVersion']
    global.state_event.versionInfoIgnoreVersionUpdated(state.ignoreVersion)
  }
  if ('progress' in snapshot) {
    Object.assign(state.progress, snapshot.progress as InitState['progress'])
    global.state_event.versionDownloadProgressUpdated({ ...state.progress })
  }
  if ('showModal' in snapshot) {
    state.showModal = snapshot.showModal as boolean
  }
})

export default {
  setVersionInfo(info: Partial<InitState['versionInfo']>) {
    const next = { ...state.versionInfo, ...info }
    pushState('version', { versionInfo: next }, () => {
      Object.assign(state.versionInfo, info)
      global.state_event.versionInfoUpdated({ ...state.versionInfo })
    })
  },
  setIgnoreVersion(version: InitState['ignoreVersion']) {
    pushState('version', { ignoreVersion: version }, () => {
      state.ignoreVersion = version
      global.state_event.versionInfoIgnoreVersionUpdated(version)
    })
  },
  setProgress(info: InitState['progress']) {
    pushState('version', { progress: { ...info } }, () => {
      Object.assign(state.progress, info)
      global.state_event.versionDownloadProgressUpdated({ ...state.progress })
    })
  },
  setVisibleModal(visible: boolean) {
    if (state.showModal == visible) return
    pushState('version', { showModal: visible }, () => { state.showModal = visible })
  },
}
