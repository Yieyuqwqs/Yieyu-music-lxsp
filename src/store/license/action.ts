import state, { type InitState } from './state'

export default {
  setInfo(info: Partial<InitState>) {
    Object.assign(state, info)
    global.state_event.licenseInfoUpdated({ ...state })
  },
}
