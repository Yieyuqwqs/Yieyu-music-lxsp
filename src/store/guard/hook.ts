import { useEffect, useState } from 'react'
import state from './state'

export const useGuardInfo = () => {
  const [info, setInfo] = useState(state)

  useEffect(() => {
    global.state_event.on('guardUpdated', setInfo)
    return () => {
      global.state_event.off('guardUpdated', setInfo)
    }
  }, [])

  return info
}
