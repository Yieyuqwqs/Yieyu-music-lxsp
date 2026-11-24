/**
 * 播放器钩子：给「一起听」这类扩展用，避免播放器核心反过来依赖房间逻辑。
 *
 * 只在状态真的变化后调用；钩子里抛错一律吞掉，绝不影响播放。
 */
export interface PlayerHooks {
  onPlay?: () => void
  onPause?: () => void
  /** 毫秒 */
  onSeek?: (positionMs: number) => void
  onTrackChange?: (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem | null) => void
  /** 直链已解析并交给播放器（此时分享给房间才有意义） */
  onResourceReady?: (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem | null) => void
}

let hooks: PlayerHooks = {}

export const setPlayerHooks = (next: PlayerHooks): void => { hooks = next }

export const clearPlayerHooks = (): void => { hooks = {} }

const safe = (fn?: () => void) => {
  if (!fn) return
  try { fn() } catch (error) { /* 钩子出错不影响播放 */ }
}

export const callOnPlay = (): void => safe(hooks.onPlay)
export const callOnPause = (): void => safe(hooks.onPause)
export const callOnSeek = (positionMs: number): void => {
  if (hooks.onSeek) { try { hooks.onSeek(positionMs) } catch (error) { /* 忽略 */ } }
}
export const callOnTrackChange = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem | null): void => {
  if (hooks.onTrackChange) { try { hooks.onTrackChange(musicInfo) } catch (error) { /* 忽略 */ } }
}
export const callOnResourceReady = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem | null): void => {
  if (hooks.onResourceReady) { try { hooks.onResourceReady(musicInfo) } catch (error) { /* 忽略 */ } }
}
