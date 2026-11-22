import { useCallback, useState } from 'react'

import { type SettingScreenIds } from '../Main'
import Dashboard from './Dashboard'
import SubScreen from './SubScreen'

export default () => {
  const [activeId, setActiveId] = useState<SettingScreenIds | null>(null)

  const handleSelect = useCallback((id: SettingScreenIds) => {
    global.lx.settingActiveId = id
    setActiveId(id)
  }, [])
  const handleBack = useCallback(() => {
    setActiveId(null)
  }, [])

  return activeId
    ? <SubScreen id={activeId} onBack={handleBack} />
    : <Dashboard onSelect={handleSelect} />
}
