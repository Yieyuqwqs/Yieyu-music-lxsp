import state, { type InitState } from './state'
import { patchState, registerDomain } from '@/core-bridge/state'

// M2 批 2：list 域下沉。大数据体（allMusicList 的 Map、各列表的音乐数组）仍留在 TS 内存，
// 只把「控制类状态」交给 C++：userList / activeListId / tempListMeta / fetchingListStatus。
registerDomain('list', snapshot => {
  if ('userList' in snapshot) {
    state.userList = snapshot.userList as InitState['userList']
    state.allList = [state.defaultList, state.loveList, ...state.userList]
    global.state_event.mylistUpdated(state.allList)
  }
  if ('activeListId' in snapshot) {
    state.activeListId = snapshot.activeListId as string
    global.state_event.mylistToggled(state.activeListId)
  }
  if ('tempListMeta' in snapshot) {
    state.tempListMeta = snapshot.tempListMeta as InitState['tempListMeta']
  }
  if ('fetchingListStatus' in snapshot) {
    state.fetchingListStatus = snapshot.fetchingListStatus as InitState['fetchingListStatus']
    global.state_event.fetchingListStatusUpdated({ ...state.fetchingListStatus })
  }
})

export default {
  setUserLists(userList: LX.List.UserListInfo[]) {
    state.userList = userList
    state.allList = [state.defaultList, state.loveList, ...state.userList]
    patchState('list', { userList })

    global.state_event.mylistUpdated(state.allList)
  },
  setActiveList(activeListId: string) {
    state.activeListId = activeListId
    patchState('list', { activeListId })

    global.state_event.mylistToggled(activeListId)
  },
  setTempListMeta(meta: InitState['tempListMeta']) {
    state.tempListMeta = meta
    patchState('list', { tempListMeta: meta })
  },
  setFetchingListStatus(id: string, status: boolean) {
    state.fetchingListStatus[id] = status
    patchState('list', { fetchingListStatus: { ...state.fetchingListStatus } })

    global.state_event.fetchingListStatusUpdated({ ...state.fetchingListStatus })
  },
}
