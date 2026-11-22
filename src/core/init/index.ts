import { initSetting, showPactModal } from '@/core/common'
import registerPlaybackService from '@/plugins/player/service'
import initTheme from './theme'
import initI18n from './i18n'
import initUserApi from './userApi'
import initPlayer from './player'
import dataInit from './dataInit'
import initSync from './sync'
import initCommonState from './common'
import { initDeeplink } from './deeplink'
import { init as initDownload } from '@/core/download'
import { init as initHistory } from '@/core/history'
import { init as initSourceMemory } from '@/core/sourceMemory'
import { setApiSource } from '@/core/apiSource'
import commonActions from '@/store/common/action'
import settingState from '@/store/setting/state'
import { checkUpdate } from '@/core/version'
import { bootLog } from '@/utils/bootLog'
import { initCoreBridge } from '@/core-bridge'
import { initStateSync } from '@/core-bridge/state'
import { cheatTip } from '@/utils/tools'
import { initLicense } from '@/core/license'
import { initBtMode } from '@/core/btMode'

let isFirstPush = true
const handlePushedHomeScreen = async() => {
  await cheatTip()
  if (settingState.setting['common.isAgreePact']) {
    if (isFirstPush) {
      isFirstPush = false
      void checkUpdate(true)
      void initDeeplink()
      void initLicense()
    }
  } else {
    if (isFirstPush) isFirstPush = false
    showPactModal()
  }
}

let isInited = false
export default async() => {
  if (isInited) return handlePushedHomeScreen
  bootLog('Initing...')
  commonActions.setFontSize(global.lx.fontSize)
  bootLog('Font size changed.')
  const setting = await initSetting()
  bootLog('Setting inited.')
  // console.log(setting)

  await initTheme(setting)
  bootLog('Theme inited.')
  await initI18n(setting)
  bootLog('I18n inited.')

  await initUserApi(setting)
  bootLog('User Api inited.')

  setApiSource(setting['common.apiSource'])
  bootLog('Api inited.')

  registerPlaybackService()
  bootLog('Playback Service Registered.')
  await initPlayer(setting)
  bootLog('Player inited.')
  await dataInit(setting)
  bootLog('Data inited.')
  await initDownload().catch(() => {})
  await initHistory().catch(() => {})
  await initSourceMemory().catch(() => {})
  bootLog('Download inited.')
  await initCommonState(setting)
  bootLog('Common State inited.')

  // 蓝牙模式：只读蓝牙输出状态 + 切换策略，不动音频底层
  await initBtMode().catch(() => {})
  bootLog('BT mode inited.')

  void initSync(setting)
  bootLog('Sync inited.')

  // M0：Fat Core 预热（只投递一次 ping，不等待、不阻塞启动）
  initCoreBridge()
  initStateSync()
  bootLog('Core bridge inited.')

  // syncSetting()

  isInited ||= true

  return handlePushedHomeScreen
}
