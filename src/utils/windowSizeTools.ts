import { Dimensions, StatusBar } from 'react-native'
import { getWindowSize as getWindowSizeRaw } from './nativeModules/utils'
// import { log } from './log'

export type SizeHandler = (size: { width: number, height: number }) => void
export const getWindowSize = async() => {
  return getWindowSizeRaw().then((size) => {
    const scale = Dimensions.get('window').scale
    size.width = size.width / scale
    size.height = size.height / scale
    return size
  })
}

export const windowSizeTools = {
  size: {
    width: 0,
    height: 0,
  },
  listeners: [] as SizeHandler[],
  getSize() {
    return this.size
  },
  onSizeChanged(handler: SizeHandler) {
    this.listeners.push(handler)

    return () => {
      this.listeners.splice(this.listeners.indexOf(handler), 1)
    }
  },
  async init() {
    // 旋转屏幕时必须重算：之前这段监听被注释掉了，横屏后尺寸一直停在竖屏值
    Dimensions.addEventListener('change', ({ window }) => {
      if (!window || !window.width || !window.height) return
      const next = {
        width: Math.round(window.width),
        height: Math.round(window.height),
      }
      if (this.size.width === next.width && this.size.height === next.height) return
      this.size = next
      for (const handler of this.listeners) handler(this.size)
    })
    const size = await getWindowSize()
    if (size.width) {
      this.size = size
    } else {
      const window = Dimensions.get('window')
      this.size = {
        width: Math.round(window.width),
        height: Math.round(window.height) + (StatusBar.currentHeight ?? 0),
      }
    }
    return size
  },
  setWindowSize(width: number, height: number) {
    this.size = {
      width: Math.round(width),
      height: Math.round(height),
    }
    for (const handler of this.listeners) handler(this.size)
  },
}
