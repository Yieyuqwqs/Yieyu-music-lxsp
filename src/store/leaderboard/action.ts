import state, { type Source, type Board, type ListDetailInfo } from './state'
import { patchState, registerDomain } from '@/core-bridge/state'

const sync = () => {
  patchState('leaderboard', { boards: { ...state.boards }, listDetailInfo: { ...state.listDetailInfo, list: undefined } })
}

const actions = {
  setBoard(board: Board, source: LX.OnlineSource) {
    state.boards[source] = board
  },
  setListDetailInfo(source: Source, id: string) {
    state.listDetailInfo.source = source
    state.listDetailInfo.id = id
  },
  setListDetail(result: ListDetailInfo, id: string, page: number) {
    state.listDetailInfo.list = page == 1 ? [...result.list] : [...state.listDetailInfo.list, ...result.list]
    state.listDetailInfo.id = id
    state.listDetailInfo.source = result.source
    if (page == 1 || (result.total && result.list.length)) state.listDetailInfo.total = result.total
    else state.listDetailInfo.total = result.limit * page
    state.listDetailInfo.limit = result.limit
    state.listDetailInfo.page = page
    state.listDetailInfo.maxPage = Math.ceil(state.listDetailInfo.total / result.limit)

    return state.listDetailInfo
  },
  clearListDetail() {
    state.listDetailInfo.list = []
    state.listDetailInfo.id = ''
    state.listDetailInfo.source = null
    state.listDetailInfo.total = 0
    state.listDetailInfo.limit = 30
    state.listDetailInfo.page = 1
    state.listDetailInfo.maxPage = 1
    state.listDetailInfo.key = null
  },
}

// M2：任何 action 执行完，把该域快照写进 C++ 真源（镜像期）
const wrapped = Object.fromEntries(Object.entries(actions).map(([key, fn]) => [key, (...args: any[]) => {
  const result = (fn as (...a: any[]) => any)(...args)
  sync()
  return result
}])) as typeof actions
export default wrapped

// M3：排行榜元数据回灌
registerDomain('leaderboard', snapshot => {
  if ('boards' in snapshot) state.boards = snapshot.boards as typeof state.boards
  if ('listDetailInfo' in snapshot) Object.assign(state.listDetailInfo, snapshot.listDetailInfo)
})
