import { useEffect, useState } from 'react'
import state from './state'

/**
 * 下载列表变更事件里的元素是同一个引用（下载过程中会原地更新），
 * 这里返回复制后的元素，以便组件能够正确重新渲染
 */
const copyList = (list: LX.Download.ListItem[]) => list.map(item => ({ ...item }))

export const useDownloadList = () => {
  const [list, setList] = useState(() => copyList(state.list))

  useEffect(() => {
    const handleUpdate = (list: LX.Download.ListItem[]) => {
      setList(copyList(list))
    }
    global.state_event.on('downloadListUpdated', handleUpdate)
    return () => {
      global.state_event.off('downloadListUpdated', handleUpdate)
    }
  }, [])

  return list
}

export const useDownloadTask = (id: string) => {
  const [task, setTask] = useState(() => {
    const target = state.list.find(t => t.id == id)
    return target ? { ...target } : undefined
  })

  useEffect(() => {
    const handleUpdate = (list: LX.Download.ListItem[]) => {
      const target = list.find(t => t.id == id)
      setTask(target ? { ...target } : undefined)
    }
    global.state_event.on('downloadListUpdated', handleUpdate)
    return () => {
      global.state_event.off('downloadListUpdated', handleUpdate)
    }
  }, [id])

  return task
}
