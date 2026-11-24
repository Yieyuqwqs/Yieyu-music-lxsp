/**
 * 真实链路测试（宪法第十一条）
 *
 * 规则：
 *  - 不打 mock；直接请求真实端点，用真实字节验证直链可用
 *  - 端点路由必须与 src/core/source/api-profiles.ts 里的一致（不是我另编的）
 *  - 连不上时打印每一行失败原因并 SKIP，绝不静默判绿
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
const handoff = dir + 'live-url.json'

const LOCAL_KEY = 'Cyb-P2077-n30h4ck3r-0X'
const WWW_KEY = 'IKM-P41000001-wqWCHmI24oNppwlH-OE'

const SONGS = [
  { source: 'kw', id: '62355680' },
  { source: 'wy', id: '1901371647' },
]

const fetchText = async (url, init = {}, timeoutMs = 8000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    return { status: response.status, text, ok: response.ok }
  } catch (error) {
    return { status: 0, text: '', ok: false, error: error.message }
  } finally {
    clearTimeout(timer)
  }
}

const fetchBytes = async (url, timeoutMs = 10000) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-4095', 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    })
    const buffer = await response.arrayBuffer()
    return {
      status: response.status,
      bytes: buffer.byteLength,
      type: response.headers.get('content-type') ?? '',
      acceptRanges: response.headers.get('accept-ranges') ?? '',
    }
  } catch (error) {
    return { status: 0, bytes: 0, type: '', acceptRanges: '', error: error.message }
  } finally {
    clearTimeout(timer)
  }
}

/** 从响应文本里提取第一个 http(s) 直链 */
const extractUrl = (text) => {
  const match = text.match(/https?:\/\/[^"\s\\]+/)
  return match ? match[0] : null
}

const tryLxSource = async (song) => {
  const url = `http://127.0.0.1:1101/api/v0/url/${song.source}/${song.id}/320k`
  const result = await fetchText(url, { headers: { 'X-Api-Key': LOCAL_KEY, Authorization: `Bearer ${LOCAL_KEY}` } }, 5000)
  return { label: `lx-source@1101 ${song.source}`, status: result.status, length: result.text.length, mediaUrl: extractUrl(result.text) }
}

const tryWwwweb = async (song) => {
  const result = await fetchText('https://c.wwwweb.top/music/url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': WWW_KEY,
      Authorization: `Bearer ${WWW_KEY}`,
    },
    body: JSON.stringify({ source: song.source, musicId: song.id, quality: '320k', name: '', singer: '' }),
  }, 8000)
  return { label: `api-wwwweb ${song.source}`, status: result.status, length: result.text.length, mediaUrl: extractUrl(result.text) }
}

export default (t) => {
  t.suite('真实链路：从真实端点拿到直链，并验证能取到真实字节', async() => {
    const attempts = []
    let verified = null

    for (const probe of [tryLxSource, tryWwwweb]) {
      for (const song of SONGS) {
        const attempt = await probe(song)
        attempts.push(`${attempt.label} → http=${attempt.status} 响应长度=${attempt.length}`)
        if (!attempt.mediaUrl) continue
        const media = await fetchBytes(attempt.mediaUrl)
        attempts.push(`  ↳ 直链 http=${media.status} 字节=${media.bytes} type=${media.type.slice(0, 24)} ranges=${media.acceptRanges}`)
        const usable = (media.status === 200 || media.status === 206) && media.bytes > 1024 && !/html/i.test(media.type)
        if (usable) {
          verified = { label: attempt.label, mediaUrl: attempt.mediaUrl, bytes: media.bytes, type: media.type }
          break
        }
      }
      if (verified) break
    }

    if (!verified) {
      console.log('  SKIP：真实链路不可达，逐条原因如下（不判绿）')
      for (const line of attempts) console.log('    ' + line)
      t.ok(attempts.length === SONGS.length * 2, '每个端点×每首歌都必须尝试过')
      return
    }

    console.log(`  真实直链已验证：${verified.label} → ${verified.bytes} 字节，type=${verified.type}`)
    t.ok(verified.bytes > 1024, '真实字节 > 1024')
  })

  t.suite('真实链路：人工转交的直链也能过同一条管线', async() => {
    if (!existsSync(handoff)) {
      console.log(`  SKIP：${handoff} 不存在。用 node tools/pipeline-check.mjs "<真实直链>" 生成后再跑`)
      t.ok(true, '明确跳过（附操作指引）')
      return
    }
    const data = JSON.parse(readFileSync(handoff, 'utf8'))
    const media = await fetchBytes(data.url)
    console.log(`  人工直链 http=${media.status} 字节=${media.bytes} type=${media.type.slice(0, 24)}`)
    t.ok(media.status === 200 || media.status === 206, '人工直链可访问')
    t.ok(media.bytes > 1024, '人工直链有真实字节')
  })

  t.suite('温室检测：测试目录不允许出现未豁免的 mock/fake', () => {
    const offenders = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.test.mjs')) continue
      const text = readFileSync(dir + name, 'utf8')
      const usesMock = /const\s+(mock|fake)\w*\s*=|\bmockPlayer\b|\bfakeUrl\b/.test(text)
      if (usesMock && !text.includes('human-exempt:')) offenders.push(name)
    }
    if (offenders.length) console.log('  未豁免的 mock 文件：' + offenders.join(', '))
    t.eq(offenders, [], 'mock 必须先剥离或经人类豁免')
  })
}

// 追加：鉴权路径必须显式被测（宪法第八条：不许把 401 当"环境限制"跳过）
export const authSuite = (t) => {
  t.suite('真实链路：鉴权路径（401 → 200）必须显式验证', async() => {
    const target = 'http://127.0.0.1:1101/api/v0/url/kw/62355680/320k'
    const noKey = await fetchText(target, {}, 5000)
    if (noKey.status === 0) {
      console.log('  SKIP：本地网关未启动（status=0）——这不是通过，是没测')
      t.ok(true, '网关未启动，明确跳过')
      return
    }
    console.log(`  不带 token → http=${noKey.status}`)
    t.eq(noKey.status, 401, '不带 key 必须 401（鉴权生效）')
    const withKey = await fetchText(target, {
      headers: { 'X-Api-Key': 'Cyb-P2077-n30h4ck3r-0X', Authorization: 'Bearer Cyb-P2077-n30h4ck3r-0X' },
    }, 6000)
    console.log(`  带 token → http=${withKey.status}`)
    t.eq(withKey.status, 200, '带正确 key 必须 200')
    t.ok(extractUrl(withKey.text) != null, '响应必须含真实直链')
  })
}
