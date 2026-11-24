#!/usr/bin/env node
/**
 * 全自动真机模拟验证（不依赖 logcat / 不需要人类操作）
 *
 * 它做的事，就是把 App 里「房间直链 → 播放器」这条决策链完整跑一遍，并注入故障：
 *   1. 从真实 LXSP 端点（本地网关，带鉴权）拿真实直链
 *   2. 用与 App 相同的 probeMediaUrl 规则验证：200/206 + 字节数 + 非 HTML
 *   3. 模拟播放器状态机：链接可用 → duration 必须 > 0；链接不可用 → 必须走回退，不许出现 00:00
 *   4. 故障注入：伪造一条坏链接（改 host），断言管线**检测到失败并回退**，而不是静默 00:00
 *
 * 输出：PASS/FAIL 矩阵 + 真实数字。任何一项 FAIL 退出码 1（可进 CI）。
 */
const KEY = process.env.LX_KEY || 'Cyb-P2077-n30h4ck3r-0X'
const BASE = process.env.LX_BASE || 'http://127.0.0.1:1101'
const SONG = { source: 'kw', id: '62355680' }

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
}

const probe = async (url, timeoutMs = 2500) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: controller.signal })
    const buffer = await response.arrayBuffer()
    const type = response.headers.get('content-type') ?? ''
    const ok = (response.status === 200 || response.status === 206) && buffer.byteLength > 512 && !/text\/html/i.test(type)
    return { ok, status: response.status, bytes: buffer.byteLength, type }
  } catch (error) {
    return { ok: false, status: 0, bytes: 0, type: '', error: error.message }
  } finally {
    clearTimeout(timer)
  }
}

/** 与 App 中 switchToTrack 等价的决策：返回它会走哪条分支 */
const decide = async (track) => {
  if (track.url && /^https?:\/\//i.test(track.url)) {
    const media = await probe(track.url)
    if (media.ok) return { branch: 'room-url', media }
    return { branch: 'fallback-local', media }
  }
  return { branch: 'fallback-local', media: null }
}

/** 模拟播放器：拿到可用 URL 才会给出 duration > 0 */
const simulatePlayer = async (url) => {
  const media = await probe(url)
  if (!media.ok) return { durationMs: 0, isPlaying: false, reason: 'load-failed' }
  // 用 Content-Range 里的总长度当作 duration 的近似证明（真实 App 由 ExoPlayer 提供）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-1' }, signal: controller.signal })
    const range = response.headers.get('content-range') ?? ''
    const total = Number((/bytes \d+-\d+\/(\d+)/.exec(range) ?? [])[1] ?? 0)
    return { durationMs: total ? Math.round(total / 16) : 0, isPlaying: true, totalBytes: total }
  } catch (error) {
    return { durationMs: 0, isPlaying: false, reason: error.message }
  } finally {
    clearTimeout(timer)
  }
}

const main = async() => {
  console.log('=== 全自动真机模拟验证（真实端点 + 真实直链 + 故障注入）===')

  const endpointUrl = `${BASE}/api/v0/url/${SONG.source}/${SONG.id}/320k`
  const response = await fetch(endpointUrl, { headers: { 'X-Api-Key': KEY, Authorization: `Bearer ${KEY}` } }).catch((error) => ({ status: 0, text: async() => error.message }))
  const text = typeof response.text === 'function' ? await response.text() : ''
  const match = /https?:\/\/[^"\s\\]+/.exec(text)
  record('端点返回真实直链', Boolean(match), `http=${response.status} 长度=${text.length}`)
  if (!match) {
    console.log('\n结论：端点不可达（http=' + response.status + '）→ 退出码 2：没测，不算通过')
    process.exit(2)
  }
  const realUrl = match[0]

  const decision = await decide({ source: SONG.source, id: SONG.id, url: realUrl, name: 'test' })
  record('决策：真实直链走 room-url 分支', decision.branch === 'room-url', `http=${decision.media.status} ${decision.media.bytes}B ${decision.media.type}`)

  const player = await simulatePlayer(realUrl)
  record('播放器：真实直链 duration > 0 且能播', player.durationMs > 0 && player.isPlaying, `duration≈${player.durationMs}ms total=${player.totalBytes ?? '-'}B`)

  // 故障注入：改坏 host，管线必须检测到并回退，绝不允许静默 00:00
  const broken = realUrl.replace(/\/\/[^/]+\//, '//invalid.invalid/')
  const brokenDecision = await decide({ source: SONG.source, id: SONG.id, url: broken, name: 'test' })
  record('故障注入：坏直链被识别并回退', brokenDecision.branch === 'fallback-local', `http=${brokenDecision.media.status} 字节=${brokenDecision.media.bytes}`)

  const brokenPlayer = await simulatePlayer(broken)
  record('故障注入：坏直链不允许“装作在播”', brokenPlayer.durationMs === 0 && brokenPlayer.isPlaying === false, `duration=${brokenPlayer.durationMs} playing=${brokenPlayer.isPlaying}`)

  const failed = results.filter((item) => !item.ok)
  console.log(`\n合计 ${results.length} 项：${results.length - failed.length} PASS / ${failed.length} FAIL`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => { console.error('脚本异常：', error.message); process.exit(1) })
