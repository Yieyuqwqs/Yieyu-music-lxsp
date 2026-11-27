import { SYNC_CLOSE_CODE } from '@/plugins/sync/constants'
import { registerDislikeActionEvent } from '../../../dislikeEvent'

let unregisterLocalListAction: (() => void) | null

export const registerEvent = (socket: LX.Sync.Socket) => {
  // socket = _socket
  // socket.onClose(() => {
  //   unregisterLocalListAction?.()
  //   unregisterLocalListAction = null
  // })
  unregisterEvent()
  unregisterLocalListAction = registerDislikeActionEvent((action) => {
    if (!socket.moduleReadys?.dislike) return
    void socket.remoteQueueDislike.onDislikeSyncAction(action).catch(err => {
      // 已知限制 1（docs/KNOWN-LIMITATIONS.md）：这里只断连，没有把失败原因回报给 UI
      socket.moduleReadys.dislike = false
      socket.close(SYNC_CLOSE_CODE.failed)
      console.log(err.message)
    })
  })
}

export const unregisterEvent = () => {
  unregisterLocalListAction?.()
  unregisterLocalListAction = null
}
