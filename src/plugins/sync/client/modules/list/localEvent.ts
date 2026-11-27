import { SYNC_CLOSE_CODE } from '@/plugins/sync/constants'
import { registerListActionEvent } from '../../../listEvent'

let unregisterLocalListAction: (() => void) | null

export const registerEvent = (socket: LX.Sync.Socket) => {
  // socket = _socket
  // socket.onClose(() => {
  //   unregisterLocalListAction?.()
  //   unregisterLocalListAction = null
  // })
  unregisterEvent()
  unregisterLocalListAction = registerListActionEvent((action) => {
    if (!socket.moduleReadys?.list) return
    void socket.remoteQueueList.onListSyncAction(action).catch(err => {
      // 已知限制 1（docs/KNOWN-LIMITATIONS.md）：这里只断连，没有把失败原因回报给 UI
      socket.moduleReadys.list = false
      socket.close(SYNC_CLOSE_CODE.failed)
      console.log(err.message)
    })
  })
}

export const unregisterEvent = () => {
  unregisterLocalListAction?.()
  unregisterLocalListAction = null
}
