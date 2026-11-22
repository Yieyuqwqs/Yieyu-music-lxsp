// import { LIST_ID_LOVE } from '@/config/constant'

import { setVolume, updateMetaData } from '@/plugins/player'
import settingState from '@/store/setting/state'
import playerState from '@/store/player/state'

export default () => {
  // const setVisibleDesktopLyric = useCommit('setVisibleDesktopLyric')
  // const setLockDesktopLyric = useCommit('setLockDesktopLyric')

  const buttons = {
    empty: true,
    collect: false,
    play: false,
    prev: true,
    next: true,
    lrc: false,
    lockLrc: false,
  }
  const setButtons = () => {
    // setPlayerAction(buttons)
    if (!playerState.playMusicInfo.musicInfo) return
    void updateMetaData(playerState.musicInfo, playerState.isPlay)
  }
  // const updateCollectStatus = async() => {
  //   // let status = !!playMusicInfo.musicInfo && await checkListExistMusic(LIST_ID_LOVE, playerState.playMusicInfo.musicInfo.id)
  //   // if (buttons.collect == status) return false
  //   // buttons.collect = status
  //   return true
  // }

  const handlePlay = () => {
    // if (buttons.empty) buttons.empty = false
    if (buttons.play) return
    buttons.play = true
    // 兜底：任何一次「恢复播放」都把音量拉回设置值。
    // 定时退出渐弱/系统挂起都可能把底层音量停在 0，表现就是「进度条在走但没声音」
    void setVolume(settingState.setting['player.volume'] ?? 1)
    setButtons()
  }
  const handlePause = () => {
    // if (buttons.empty) buttons.empty = false
    if (!buttons.play) return
    buttons.play = false
    setButtons()
  }
  // const handleStop = () => {
  //   // if (playerState.playMusicInfo.musicInfo != null) return
  //   // if (buttons.collect) buttons.collect = false
  //   // buttons.empty = true
  //   setButtons()
  // }
  // const handleSetPlayInfo = () => {
  //   void updateCollectStatus().then(isExist => {
  //     if (isExist) setButtons()
  //   })
  // }
  // const handleSetTaskbarThumbnailClip = (clip) => {
  //   setTaskbarThumbnailClip(clip)
  // }
  // const throttleListChange = throttle(async listIds => {
  //   if (!listIds.includes(loveList.id)) return
  //   if (await updateCollectStatus()) setButtons()
  // })
  // const updateSetting = () => {
  //   const setting = store.getters.setting
  //   buttons.lrc = setting.desktopLyric.enable
  //   buttons.lockLrc = setting.desktopLyric.isLock
  //   setButtons()
  // }
  global.app_event.on('play', handlePlay)
  global.app_event.on('pause', handlePause)
  global.app_event.on('stop', handlePause)
  // global.app_event.on('musicToggled', handleSetPlayInfo)
  // window.app_event.on(eventTaskbarNames.setTaskbarThumbnailClip, handleSetTaskbarThumbnailClip)
  // window.app_event.on('myListMusicUpdate', throttleListChange)

  return async() => {
    // const setting = store.getters.setting
    // buttons.lrc = setting.desktopLyric.enable
    // buttons.lockLrc = setting.desktopLyric.isLock
    // await updateCollectStatus()
    // if (playMusicInfo.musicInfo != null) buttons.empty = false
    setButtons()
  }
}
