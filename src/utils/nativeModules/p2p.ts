/**
 * 直连通道（原生 C++：STUN 打洞 + UDP）
 *
 * 只传控制消息（几十字节），不传音频。拿到直连就用它，拿不到就自动退回 MQTT。
 * 这一层就是「F1 引擎」：没有 broker 中转，消息直接打到对方手机上。
 */
import { NativeModules } from 'react-native'

interface P2PModule {
  p2pStart?: (host: string, port: number, timeoutMs: number) => Promise<string>
  p2pLocalIp?: () => Promise<string>
  p2pConnect?: (ip: string, port: number) => Promise<boolean>
  p2pSend?: (text: string) => Promise<boolean>
  p2pPoll?: (timeoutMs: number) => Promise<string>
  p2pStats?: () => Promise<string>
  p2pStop?: () => Promise<boolean>
}

const native = (NativeModules as { YieyuCore?: P2PModule }).YieyuCore

export const isDirectAvailable = (): boolean => typeof native?.p2pStart === 'function'

export interface DirectAddress {
  /** 公网 ip:port（STUN 拿到的映射） */
  mapped: string
  privateIp: string
}

/** 建立本地 UDP 端点并拿到公网映射 */
export const directStart = async(stunHost = 'stun.l.google.com', stunPort = 19302, timeoutMs = 3000): Promise<DirectAddress | null> => {
  if (!native?.p2pStart) return null
  try {
    const mapped = await native.p2pStart(stunHost, stunPort, timeoutMs)
    if (!mapped || mapped.startsWith('ERR:')) return null
    const privateIp = (await native.p2pLocalIp?.()) ?? ''
    return { mapped, privateIp }
  } catch (error) {
    return null
  }
}

/** 打洞 + 指定对端 */
export const directConnect = async(mapped: string): Promise<boolean> => {
  const [ip, portText] = mapped.split(':')
  const port = Number(portText)
  if (!native?.p2pConnect || !ip || !Number.isFinite(port)) return false
  try {
    return await native.p2pConnect(ip, port)
  } catch (error) {
    return false
  }
}

export const directSend = async(text: string): Promise<boolean> => {
  if (!native?.p2pSend) return false
  try {
    return await native.p2pSend(text)
  } catch (error) {
    return false
  }
}

/** 收一条（阻塞 timeoutMs，没消息返回空串） */
export const directPoll = async(timeoutMs = 300): Promise<string> => {
  if (!native?.p2pPoll) return ''
  try {
    return (await native.p2pPoll(timeoutMs)) ?? ''
  } catch (error) {
    return ''
  }
}

export const directStats = async(): Promise<string> => {
  if (!native?.p2pStats) return ''
  try {
    return await native.p2pStats()
  } catch (error) {
    return ''
  }
}

export const directStop = async(): Promise<void> => {
  if (!native?.p2pStop) return
  try {
    await native.p2pStop()
  } catch (error) { /* 忽略 */ }
}
