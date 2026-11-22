import { useEffect } from 'react'
import { useHorizontalMode } from '@/utils/hooks'
import PageContent from '@/components/PageContent'
import { setComponentId } from '@/core/common'
import { COMPONENT_IDS } from '@/config/constant'
import Vertical from './Vertical'
import Horizontal from './Horizontal'
import { navigations } from '@/navigation'
import settingState from '@/store/setting/state'
import ErrorBoundary from '@/components/common/ErrorBoundary'
import ForceUpdateModal from '@/components/ForceUpdateModal'
import { startForceUpdateGuard } from '@/core/forceUpdate'


interface Props {
  componentId: string
}


export default ({ componentId }: Props) => {
  const isHorizontalMode = useHorizontalMode()
  // 强更拦截：启动即校验，前后台切换再校验
  useEffect(() => { startForceUpdateGuard() }, [])
  useEffect(() => {
    setComponentId(COMPONENT_IDS.home, componentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps

    if (settingState.setting['player.startupPushPlayDetailScreen']) {
      navigations.pushPlayDetailScreen(componentId, true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <PageContent>
      <ForceUpdateModal />
      <ErrorBoundary name="主页">
        {isHorizontalMode ? <Horizontal /> : <Vertical />}
      </ErrorBoundary>
    </PageContent>
  )
}
