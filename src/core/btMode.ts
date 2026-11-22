// 蓝牙模式（Phase 1）：只做策略与状态，不碰任何音频底层代码
//
// 为什么需要它：
//   · 蓝牙（AAC/SBC/aptX/LDAC）输出时，AudioFlinger 会按编码器支持的采样率再降采样一次，
//     我们自己的 192kHz 升频等于「插值上去 → 系统再降下来」，多两次重采样，反而更糊；
//   · 蓝牙链路延迟 100~300ms，而歌词跟的是 HAL 播放头，不含这段延迟 → 歌词会「抢拍」。
//
// 所以蓝牙一连上就自动：
//   ① 关掉 Hi-Res 插值升频（记录原值，断开后恢复）
//   ② 关掉 audio offload（BT 下无收益，且可能绕开我们的音效处理）
//   ③ 给歌词加负补偿（bt.lyricCompensation，默认 175ms ≈ AAC 折中值）
// 断开蓝牙后自动还原 ①②，③ 由 lyric.ts 按状态实时合成。

import { updateSetting } from '@/core/common'
import { applyHiRes } from '@/plugins/player/soundEffect'
import settingState from '@/store/setting/state'
import { getBtAudioState, onBtAudioChanged, type BtAudioState } from '@/utils/nativeModules/btAudio'

// 运行时 require：core/common 的依赖图很大，顶层 import 容易和 lyric/player 形成环
const getUpdateSetting = () => (
  require('@/core/common') as typeof import('@/core/common')
).updateSetting

const EMPTY_STATE: BtAudioState = { connected: false, name: '', type: '' }

let state: BtAudioState = EMPTY_STATE
let inited = false
/** 进入蓝牙模式前用户自己的设置，断开时原样还回去 */
let saved: { hires: boolean, offload: boolean } | null = null

type Listener = (state: BtAudioState) => void
const listeners = new Set<Listener>()

export const getBtState = (): BtAudioState => state

export const subscribeBtState = (listener: Listener) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const emit = () => {
  for (const listener of listeners) listener(state)
}

/** 蓝牙模式下应该叠加到歌词偏移上的值（毫秒，负值 = 歌词延后） */
export const getBtLyricOffsetShift = (): number => {
  const setting = settingState.setting
  if (setting['bt.autoMode'] !== true) return 0
  if (!state.connected) return 0
  const compensation = Number(setting['bt.lyricCompensation'])
  const ms = Number.isFinite(compensation) ? Math.max(0, Math.min(600, Math.round(compensation))) : 175
  return -ms
}

const restoreSettings = () => {
  const setting = settingState.setting
  const patch: Partial<LX.AppSetting> = {}
  if (saved) {
    if (saved.hires && setting['player.hires.enable'] !== true) patch['player.hires.enable'] = true
    if (saved.offload && setting['player.isEnableAudioOffload'] !== true) patch['player.isEnableAudioOffload'] = true
    saved = null
  }
  if (Object.keys(patch).length > 0) {
    getUpdateSetting()(patch)
    applyHiRes()
  }
}

const applySettings = () => {
  const setting = settingState.setting
  if (!saved) {
    saved = {
      hires: setting['player.hires.enable'] === true,
      offload: setting['player.isEnableAudioOffload'] === true,
    }
  }
  const patch: Partial<LX.AppSetting> = {}
  if (setting['player.hires.enable'] === true) patch['player.hires.enable'] = false
  if (setting['player.isEnableAudioOffload'] === true) patch['player.isEnableAudioOffload'] = false
  if (Object.keys(patch).length > 0) {
    getUpdateSetting()(patch)
    applyHiRes()
  }
}

const applyAutoMode = () => {
  if (settingState.setting['bt.autoMode'] !== true) return
  if (state.connected) applySettings()
  else if (saved) restoreSettings()
}

const handleState = (next: BtAudioState) => {
  const changed = next.connected !== state.connected ||
    next.name !== state.name ||
    next.type !== state.type
  state = next
  if (changed) {
    emit()
    applyAutoMode()
  }
}

/** 用户手动关掉「蓝牙自动优化」时，立刻把之前改过的设置还原 */
export const resetBtAutoMode = () => {
  if (saved) restoreSettings()
}

export const initBtMode = async() => {
  if (inited) return
  inited = true
  onBtAudioChanged(handleState)
  global.state_event.on('configUpdated', (keys) => {
    if (keys.includes('bt.autoMode') && settingState.setting['bt.autoMode'] !== true) resetBtAutoMode()
  })
  try {
    handleState(await getBtAudioState())
  } catch {
    handleState(EMPTY_STATE)
  }
}
