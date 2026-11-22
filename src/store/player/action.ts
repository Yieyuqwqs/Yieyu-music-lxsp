import { arrPush, arrUnshift, formatPlayTime2 } from '@/utils'
import state from './state'
import { patchState, registerDomain } from '@/core-bridge/state'

// M2 批 3：player 域下沉（播放状态机核心）。
// 下沉字段：playInfo / playMusicInfo / musicInfo / isPlay / volume / playRate /
//           statusText / progress / lastLyric / loadErrorPicUrl
// 仍留 TS：playedList / tempPlayList（可能很长，避免每次 patch 过 JNI 传几十 KB；
//          持久化交给 SQLite，由 M3 处理）
const MIRRORED = [
  'playInfo', 'playMusicInfo', 'musicInfo', 'isPlay', 'volume', 'playRate',
  'statusText', 'progress', 'lastLyric', 'loadErrorPicUrl',
] as const

type MirroredKey = typeof MIRRORED[number]

const sync = (fields: MirroredKey[]) => {
  const patch: Record<string, unknown> = {}
  for (const key of fields) patch[key] = state[key]
  patchState('player', patch)
}

registerDomain('player', snapshot => {
  if ('playInfo' in snapshot) {
    Object.assign(state.playInfo, snapshot.playInfo as typeof state.playInfo)
    global.state_event.playInfoChanged({ ...state.playInfo })
  }
  if ('playMusicInfo' in snapshot) {
    Object.assign(state.playMusicInfo, snapshot.playMusicInfo as typeof state.playMusicInfo)
    global.state_event.playMusicInfoChanged(state.playMusicInfo)
  }
  if ('musicInfo' in snapshot) {
    Object.assign(state.musicInfo, snapshot.musicInfo as typeof state.musicInfo)
    global.state_event.playerMusicInfoChanged({ ...state.musicInfo })
  }
  if ('isPlay' in snapshot) {
    state.isPlay = snapshot.isPlay as boolean
    global.state_event.playStateChanged(state.isPlay)
  }
  if ('statusText' in snapshot) {
    state.statusText = snapshot.statusText as string
    global.state_event.playStateTextChanged(state.statusText)
  }
  if ('progress' in snapshot) {
    Object.assign(state.progress, snapshot.progress as typeof state.progress)
    global.state_event.playProgressChanged({ ...state.progress })
  }
  if ('volume' in snapshot) state.volume = snapshot.volume as number
  if ('playRate' in snapshot) state.playRate = snapshot.playRate as number
  if ('lastLyric' in snapshot) state.lastLyric = snapshot.lastLyric as string | undefined
  if ('loadErrorPicUrl' in snapshot) state.loadErrorPicUrl = snapshot.loadErrorPicUrl as string
})

type PlayerMusicInfoKeys = keyof LX.Player.MusicInfo
const musicInfoKeys: PlayerMusicInfoKeys[] = Object.keys(state.musicInfo) as PlayerMusicInfoKeys[]

export default {
  updatePlayIndex(playIndex: number, playerPlayIndex: number) {
    state.playInfo.playIndex = playIndex
    state.playInfo.playerPlayIndex = playerPlayIndex
    sync(['playInfo'])

    global.state_event.playInfoChanged({ ...state.playInfo })
  },
  setPlayListId(playerListId: string | null) {
    state.playInfo.playerListId = playerListId
    sync(['playInfo'])

    global.state_event.playInfoChanged({ ...state.playInfo })
  },
  setPlayMusicInfo(listId: string | null, musicInfo: LX.Download.ListItem | LX.Music.MusicInfo | null, isTempPlay: boolean = false) {
    state.playMusicInfo = { listId, musicInfo, isTempPlay }
    sync(['playMusicInfo'])

    global.state_event.playMusicInfoChanged(state.playMusicInfo)
  },
  setMusicInfo(_musicInfo: Partial<LX.Player.MusicInfo>) {
    for (const key of musicInfoKeys) {
      const val = _musicInfo[key]
      if (val !== undefined) {
        // @ts-expect-error
        state.musicInfo[key] = val
      }
    }
    sync(['musicInfo'])

    global.state_event.playerMusicInfoChanged({ ...state.musicInfo })
  },
  setIsPlay(isPlay: boolean) {
    state.isPlay = isPlay
    sync(['isPlay'])

    global.state_event.playStateChanged(isPlay)
  },
  setStatusText(statusText: string) {
    state.statusText = statusText
    sync(['statusText'])
    global.state_event.playStateTextChanged(statusText)
  },
  setNowPlayTime(time: number) {
    state.progress.nowPlayTime = time
    state.progress.nowPlayTimeStr = formatPlayTime2(time)
    state.progress.progress = state.progress.maxPlayTime ? time / state.progress.maxPlayTime : 0
    sync(['progress'])

    global.state_event.playProgressChanged({ ...state.progress })
  },
  setMaxplayTime(time: number) {
    state.progress.maxPlayTime = time
    state.progress.maxPlayTimeStr = formatPlayTime2(time)
    state.progress.progress = time ? state.progress.nowPlayTime / time : 0
    sync(['progress'])

    global.state_event.playProgressChanged({ ...state.progress })
  },
  setProgress(currentTime: number, totalTime: number) {
    state.progress.nowPlayTime = currentTime
    state.progress.nowPlayTimeStr = formatPlayTime2(currentTime)
    state.progress.maxPlayTime = totalTime
    state.progress.maxPlayTimeStr = formatPlayTime2(totalTime)
    state.progress.progress = totalTime ? state.progress.nowPlayTime / currentTime : 0
    sync(['progress'])

    global.state_event.playProgressChanged({ ...state.progress })
  },
  addPlayedList(info: LX.Player.PlayMusicInfo) {
    if (state.playedList.some(m => m.musicInfo.id == info.musicInfo.id)) return
    state.playedList.push(info)

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  removePlayedList(index: number) {
    state.playedList.splice(index, 1)

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  clearPlayedList() {
    state.playedList = []

    global.state_event.playPlayedListChanged({ ...state.playedList })
  },
  addTempPlayList(list: LX.Player.TempPlayListItem[]) {
    const topList: Array<{ listId: string | null, musicInfo: LX.Music.MusicInfo | LX.Download.ListItem }> = []
    const bottomList = list.filter(({ isTop, ...musicInfo }) => {
      if (isTop) {
        topList.push(musicInfo)
        return false
      }
      return true
    })
    if (topList.length) arrUnshift(state.tempPlayList, topList.map(({ musicInfo, listId }) => ({ musicInfo, listId, isTempPlay: true })))
    if (bottomList.length) arrPush(state.tempPlayList, bottomList.map(({ musicInfo, listId }) => ({ musicInfo, listId, isTempPlay: true })))

    global.state_event.playTempPlayListChanged({ ...state.tempPlayList })
  },
  removeTempPlayList(index: number) {
    state.tempPlayList.splice(index, 1)

    global.state_event.playTempPlayListChanged({ ...state.tempPlayList })
  },
  clearTempPlayeList() {
    state.tempPlayList = []

    global.state_event.playTempPlayListChanged({ ...state.tempPlayList })
  },
  setLoadErrorPicUrl(url: string) {
    state.loadErrorPicUrl = url
    sync(['loadErrorPicUrl'])
  },
  setLastLyric(lrc?: string) {
    state.lastLyric = lrc
    sync(['lastLyric'])
  },
}
