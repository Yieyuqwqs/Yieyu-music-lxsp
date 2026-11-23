/** WASM 插件运行时（原生 wasm3）的 RN 桥 */
import { NativeModules } from 'react-native'

interface WasmRuntimeNative {
  wasmLoad: (base64: string) => Promise<number>
  wasmResolve: (handle: number, payload: string) => Promise<string>
  wasmFree: (handle: number) => Promise<void>
}

const native = (NativeModules as { YieyuCore?: WasmRuntimeNative }).YieyuCore

export const isWasmRuntimeAvailable = (): boolean => !!native?.wasmLoad

export const wasmLoad = (base64: string): Promise<number> => {
  if (!native?.wasmLoad) return Promise.reject(new Error('WASM 运行时不可用（native 未加载）'))
  return native.wasmLoad(base64)
}

export const wasmResolve = (handle: number, payload: string): Promise<string> => {
  if (!native?.wasmResolve) return Promise.reject(new Error('WASM 运行时不可用'))
  return native.wasmResolve(handle, payload)
}

export const wasmFree = (handle: number): Promise<void> => {
  if (!native?.wasmFree) return Promise.resolve()
  return native.wasmFree(handle)
}
