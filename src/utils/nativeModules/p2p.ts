/**
 * 直连通道（原生 C++：STUN 打洞 + UDP）
 *
 * 只传控制消息（几十字节），不传音频。拿到直连就用它，拿不到就自动退回 MQTT。
 * 这一层就是「F1 引擎」：没有 broker 中转，消息直接打到对方手机上。
 */
import { DeviceEventEmitter, NativeModules } from 'react-native'

interface P2PModule {
  p2pStart?: (host: string, port: number, timeoutMs: number) => Promise<string>
  p2pLocalIp?: () => Promise<string>
  p2pConnect?: (ip: string, port: number) => Promise<boolean>
  p2pSend?: (text: string) => Promise<boolean>
  p2pPoll?: (timeoutMs: number) => Promise<string>
  p2pStats?: () => Promise<string>
  p2pStop?: () => Promise<boolean>
  p2pStartPump?: () => Promise<boolean>
  p2pStopPump?: () => Promise<boolean>
}

const native = (NativeModules as { YieyuCore?: P2PModule }).YieyuCore

export const isDirectAvailable = (): boolean => typeof native?.p2pStart === 'function'

export interface DirectAddress {
  /** 公网 ip:port（STUN 拿到的映射） */
  mapped: string
  privateIp: string
}

/**
 * STUN 服务器优先级列表。
 * 实测（本机网络）：stun.miwifi.com 可通 39–52ms；stun.l.google.com / stun.cloudflare.com 无响应（被拦）。
 * 所以国内优先，google 只当最后兜底 —— 之前默认 google 是直连一直不生效的根因。
 */
const STUN_SERVERS: Array<[string, number]> = [
  ['stun.miwifi.com', 3478],
  ['stun.qq.com', 3478],
  ['stun.chat.bilibili.com', 3478],
  ['stun.l.google.com', 19302],
]
let preferredStunIndex = 0

/** 建立本地 UDP 端点并拿到公网映射（自动在 STUN 列表里失败重试） */
export const directStart = async(timeoutMs = 2500): Promise<DirectAddress | null> => {
  if (!native?.p2pStart) return null
  // 从上次成功的服务器开始试，失败就换下一个（环形遍历一次）
  const count = STUN_SERVERS.length
  for (let attempt = 0; attempt < count; attempt++) {
    const index = (preferredStunIndex + attempt) % count
    const [host, port] = STUN_SERVERS[index]
    try {
      const mapped = await native.p2pStart(host, port, timeoutMs)
      if (mapped && !mapped.startsWith('ERR:')) {
        preferredStunIndex = index
        const privateIp = (await native.p2pLocalIp?.()) ?? ''
        return { mapped, privateIp }
      }
    } catch (error) { /* 换下一个 */ }
  }
  return null
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


/**
 * 原生推送：C++ 收到包后由 Java 泵直接 emit 给 JS。
 * 比 JS 轮询快 0–300ms（轮询间隔那一段全没了），热路径上这是最值钱的一刀。
 */
export const startDirectPump = (handler: (text: string) => void): (() => void) => {
  if (!native?.p2pStartPump) return () => {}
  const subscription = DeviceEventEmitter.addListener('lxp2p:message', (text: string) => {
    if (typeof text === string && text) handler(text)
  })
  void native.p2pStartPump().catch(() => {})
  return () => {
    subscription.remove()
    void native?.p2pStopPump?.().catch(() => {})
  }
}
