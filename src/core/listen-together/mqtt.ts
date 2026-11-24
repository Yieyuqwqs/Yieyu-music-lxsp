import { reportError } from '@/core/listen-together/errors'
/**
 * 极简 MQTT 3.1.1 over WebSocket（只做 qos0 的 pub/sub + keepalive）
 *
 * 为什么手写：不想为「一起听」再塞一个 npm 依赖进 RN 包里；只需 CONNECT/SUBSCRIBE/PUBLISH/PING。
 * 公共 broker 免注册、免部署，是「零配置一起听」的传输层。
 */

const textEncoder = {
  encode: (text: string): Uint8Array => {
    const bytes: number[] = []
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i)
      if (code < 0x80) bytes.push(code)
      else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(++i)
        const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
      } else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
    return new Uint8Array(bytes)
  },
  decode: (bytes: Uint8Array): string => {
    let out = ''
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
    try { return decodeURIComponent(escape(out)) } catch (error) { reportError('mqtt:utf8', error); return out }
  },
}

const varint = (num: number): number[] => {
  const out: number[] = []
  let n = num
  do {
    let digit = n % 128
    n = Math.floor(n / 128)
    if (n > 0) digit |= 0x80
    out.push(digit)
  } while (n > 0)
  return out
}

const utf8Field = (text: string): number[] => {
  const bytes = textEncoder.encode(text)
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes]
}

const packet = (header: number, body: number[]): Uint8Array => Uint8Array.from([header, ...varint(body.length), ...body])

export interface MqttOptions {
  url?: string
  clientId?: string
  keepaliveSeconds?: number
  onConnect?: () => void
  onClose?: () => void
  onMessage?: (topic: string, payload: string) => void
  onError?: (error: Error) => void
}

export const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt'

export class MqttClient {
  private readonly url: string
  private readonly clientId: string
  private readonly keepaliveSeconds: number
  private readonly options: MqttOptions
  private ws: WebSocket | null = null
  private rest = new Uint8Array(0)
  private topics = new Set<string>()
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false
  private ready = false
  private reconnectAttempt = 0
  private packetId = 0
  /** qos1 已发布但还没收到 PUBACK 的消息（丢了就靠 broker 重投） */
  private inflight = new Map<number, string>()

  constructor(options: MqttOptions = {}) {
    this.options = options
    this.url = options.url ?? DEFAULT_BROKER
    this.clientId = options.clientId ?? `lx-listen-${Math.random().toString(16).slice(2, 12)}`
    this.keepaliveSeconds = options.keepaliveSeconds ?? 30
  }

  get connected(): boolean {
    return this.ready
  }

  connect(): void {
    this.closedByUser = false
    const WebSocketImpl = (globalThis as { WebSocket?: new (url: string, protocols?: string | string[]) => WebSocket }).WebSocket
    if (!WebSocketImpl) {
      this.options.onError?.(new Error('环境里没有 WebSocket'))
      return
    }
    // broker 要求子协议为 mqtt，否则 400
    const ws = new WebSocketImpl(this.url, ['mqtt'])
    this.ws = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      this.reconnectAttempt = 0
      ws.send(this.connectPacket())
    }
    ws.onmessage = (event: MessageEvent) => {
      const data = event.data
      const chunk = typeof data === 'string' ? textEncoder.encode(data) : new Uint8Array(data as ArrayBuffer)
      this.handleBytes(chunk)
    }
    ws.onclose = () => {
      this.ready = false
      this.stopPing()
      this.options.onClose?.()
      if (!this.closedByUser) this.scheduleReconnect()
    }
    ws.onerror = () => {
      this.options.onError?.(new Error('MQTT WebSocket 出错'))
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectAttempt += 1
    const delay = Math.min(8000, 400 * Math.pow(2, this.reconnectAttempt - 1))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closedByUser) this.connect()
    }, delay)
  }

  private connectPacket(): Uint8Array {
    return packet(0x10, [
      ...utf8Field('MQTT'), 0x04, 0x02,
      (this.keepaliveSeconds >> 8) & 0xff, this.keepaliveSeconds & 0xff,
      ...utf8Field(this.clientId),
    ])
  }

  private handleBytes(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.rest.length + chunk.length)
    merged.set(this.rest)
    merged.set(chunk, this.rest.length)
    let offset = 0
    while (offset + 2 <= merged.length) {
      const header = merged[offset]
      let multiplier = 1
      let length = 0
      let pos = offset + 1
      let digit: number
      do {
        if (pos >= merged.length) { this.rest = merged.subarray(offset); return }
        digit = merged[pos++]
        length += (digit & 0x7f) * multiplier
        multiplier *= 128
      } while (digit & 0x80)
      if (pos + length > merged.length) { this.rest = merged.subarray(offset); return }
      const body = merged.subarray(pos, pos + length)
      const type = header >> 4
      if (type === 2) {
        // CONNACK
        this.ready = true
        for (const topic of this.topics) this.sendSubscribe(topic)
        this.startPing()
        this.options.onConnect?.()
      } else if (type === 3) {
        // PUBLISH（qos1 会多带 2 字节 packetId，要按 QoS 位判断）
        const qos = (header >> 1) & 0x03
        const topicLen = (body[0] << 8) | body[1]
        const topic = textEncoder.decode(body.subarray(2, 2 + topicLen))
        const offsetAfterTopic = 2 + topicLen + (qos > 0 ? 2 : 0)
        const payload = textEncoder.decode(body.subarray(offsetAfterTopic))
        if (qos === 1) {
          // 回 PUBACK（报文类型 4）
          const id = (body[2 + topicLen] << 8) | body[3 + topicLen]
          try { this.ws?.send(Uint8Array.from([0x40, 0x02, (id >> 8) & 0xff, id & 0xff])) } catch (error) { reportError('mqtt:puback', error) }
        }
        this.options.onMessage?.(topic, payload)
      } else if (type === 4) {
        // PUBACK：清 inflight
        const id = (body[0] << 8) | body[1]
        this.inflight.delete(id)
      }
      offset = pos + length
    }
    this.rest = merged.subarray(offset)
  }

  subscribe(topic: string): void {
    this.topics.add(topic)
    if (this.ready) this.sendSubscribe(topic)
  }

  unsubscribe(topic: string): void {
    this.topics.delete(topic)
    if (!this.ready || !this.ws) return
    const body = [0x00, 0x02, ...utf8Field(topic)]
    try { this.ws.send(packet(0xa2, body)) } catch (error) { reportError('mqtt:unsubscribe', error) }
  }

  private sendSubscribe(topic: string): void {
    if (!this.ws) return
    try { this.ws.send(packet(0x82, [0x00, 0x01, ...utf8Field(topic), 0x01])) } catch (error) { reportError('mqtt:subscribe', error) }
  }

  publish(topic: string, payload: string): boolean {
    if (!this.ready || !this.ws) return false
    // QoS1：带 packetId，broker 收到会回 PUBACK；没回就一直重投，换歌/拖动不会凭空丢掉
    this.packetId = (this.packetId % 65535) + 1
    const id = this.packetId
    const body = [...utf8Field(topic), (id >> 8) & 0xff, id & 0xff, ...textEncoder.encode(payload)]
    try {
      this.ws.send(packet(0x32, body))
      this.inflight.set(id, payload)
      setTimeout(() => { this.inflight.delete(id) }, 10_000)
      return true
    } catch (error) {
      reportError('mqtt:publish', error)
      return false
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (!this.ready || !this.ws) return
      try { this.ws.send(Uint8Array.from([0xc0, 0x00])) } catch (error) { reportError('mqtt:ping', error) }
    }, Math.max(5, Math.floor(this.keepaliveSeconds / 2)) * 1000)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  close(): void {
    this.closedByUser = true
    this.ready = false
    this.stopPing()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.ws) {
      try { this.ws.send(Uint8Array.from([0xe0, 0x00])); this.ws.close() } catch (error) { reportError('mqtt:close', error) }
      this.ws = null
    }
  }
}
