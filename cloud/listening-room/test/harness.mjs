/** 最小 DO 测试台：假 storage / 假 WebSocket / 假 ctx，足够跑通消息流 */
export const installStubs = () => {
  globalThis.WebSocketRequestResponsePair = class {
    constructor(request, response) { this.request = request; this.response = response }
  }
  globalThis.WebSocketPair ??= class {
    constructor() {
      const client = { sent: [], send: (d) => { client.sent.push(d) } }
      const server = { sent: [], send: (d) => { server.sent.push(d) } }
      this[0] = client
      this[1] = server
      return { 0: client, 1: server }
    }
  }
}

export const createHarness = () => {
  const store = new Map()
  const sockets = [] // { ws, tags }
  const alarms = []

  const storage = {
    get: async (key) => store.has(key) ? store.get(key) : undefined,
    put: async (key, value) => { store.set(key, structuredClone(value)) },
    delete: async (key) => store.delete(key),
    setAlarm: async (at) => { alarms.push(at) },
    getAlarm: async () => alarms.length ? alarms[alarms.length - 1] : null,
  }

  const ctx = {
    id: { toString: () => 'do-internal-id' },
    storage,
    acceptWebSocket: (ws, tags = []) => { sockets.push({ ws, tags }) },
    getWebSockets: () => sockets.map(item => item.ws),
    getTags: (ws) => sockets.find(item => item.ws === ws)?.tags ?? [],
    setWebSocketAutoResponse: () => {},
    waitUntil: () => {},
  }

  return { store, sockets, alarms, ctx, storage }
}
