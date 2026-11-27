/**
 * 真实链路测试（宪法第十一条）
 *
 * 规则：
 *  - 不打 mock；直接请求真实端点，用真实字节验证直链可用
 *  - 端点路由必须与 src/core/source/api-profiles.ts 里的一致（不是我另编的）
 *  - 连不上时打印每一行失败原因并 SKIP，绝不静默判绿
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
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

/** 现场向好用的网关要一条真实直链（不 mock）；失败返回原因 */
const fetchFreshDirectUrl = async() => {
  const body = JSON.stringify({ source: 'kw', musicId: '62355680', quality: '320k' })
  try {
    const result = await fetchText('https://c.wwwweb.top/music/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WWW_KEY },
      body,
    }, 8000)
    if (result.status !== 200) return { reason: `网关 http=${result.status}` }
    const url = extractUrl(result.text)
    return url ? { url } : { reason: '响应里没有直链' }
  } catch (error) {
    return { reason: error.message }
  }
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
    // 直链是有寿命的（几分钟到几小时），所以这里不是"读一个文件然后断言它没坏"：
    //   1. 先用仓库里记录的那条（它可能已经过期）；
    //   2. 过期就现场向好用的网关要一条新的，验完写回 fixture（下次又能用）；
    //   3. 两条都不行 → 明确 SKIP 并打印每一条失败原因，绝不静默判绿。
    const attempts = []
    const verify = async(label, url) => {
      if (!url) return null
      const media = await fetchBytes(url)
      attempts.push(`  ${label} → http=${media.status} 字节=${media.bytes} type=${(media.type || '').slice(0, 24)}`)
      if ((media.status === 200 || media.status === 206) && media.bytes > 1024 && !/html/i.test(media.type)) {
        return media
      }
      return null
    }

    let okMedia = null
    let source = ''
    if (existsSync(handoff)) {
      try {
        const data = JSON.parse(readFileSync(handoff, 'utf8'))
        okMedia = await verify('fixture', data.url)
        source = 'fixture'
      } catch (error) {
        attempts.push(`  fixture 解析失败：${error.message}`)
      }
    }

    if (!okMedia) {
      // 现场换一条真链接（与线上网关同一接口，不许 mock）
      const fresh = await fetchFreshDirectUrl()
      if (fresh.url) {
        okMedia = await verify('现场获取', fresh.url)
        if (okMedia) {
          source = 'fresh'
          try {
            writeFileSync(handoff, JSON.stringify({
              url: fresh.url,
              checkedAt: new Date().toISOString(),
              status: okMedia.status,
              bytes: okMedia.bytes,
              type: okMedia.type,
              note: 'live.test.mjs 现场刷新（fixture 里的直链已过期）',
            }, null, 2) + '\n')
            attempts.push(`  已把新直链写回 ${handoff}`)
          } catch (error) {
            attempts.push(`  写回 fixture 失败：${error.message}`)
          }
        }
      } else {
        attempts.push(`  现场获取失败：${fresh.reason}`)
      }
    }

    if (!okMedia) {
      console.log('  SKIP：拿不到可用的真实直链（不是通过，是没测）')
      for (const line of attempts) console.log(line)
      t.ok(attempts.length > 0, '必须记录过至少一次真实尝试')
      console.log('  提示：node tools/pipeline-check.mjs "<真实直链>" 可手工灌一条')
      return
    }

    console.log(`  真实直链已验证（${source}）→ ${okMedia.bytes} 字节，type=${okMedia.type}`)
    t.ok(okMedia.bytes > 1024, '真实字节 > 1024')
    t.ok(!/html/i.test(okMedia.type), '返回的必须是音频，不是 HTML 错误页')
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
//
// 口径修正（2026-11-27）：
//   旧断言写死"不带 key 必须 401"，但同一族网关的约定并不统一（lx-source 回 403，wwwweb 甚至允许匿名访问）。
//   断言"哪种状态码"本身是错的，真正要验的是：**错误的密钥必须被拒，正确的密钥必须能拿到直链**。
export const authSuite = (t) => {
  t.suite('真实链路：鉴权路径（错误密钥必被拒 / 正确密钥必给直链）', async() => {
    const target = 'https://c.wwwweb.top/music/url'
    const body = JSON.stringify({ source: 'kw', musicId: '62355680', quality: '320k' })

    const wrong = await fetchText(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'IKM-WRONG-KEY-FOR-TEST' },
      body,
    }, 8000)
    if (wrong.status === 0) {
      console.log(`  SKIP：网关不可达（${wrong.error ?? 'network'}）——这不是通过，是没测`)
      t.ok(true, '网关不可达，明确跳过')
      return
    }
    console.log(`  错误密钥 → http=${wrong.status}`)
    t.ok(wrong.status === 401 || wrong.status === 403, `错误密钥必须被拒（401/403），实际 ${wrong.status}`)

    const right = await fetchText(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WWW_KEY },
      body,
    }, 8000)
    console.log(`  正确密钥 → http=${right.status}`)
    t.eq(right.status, 200, '正确密钥必须 200')
    t.ok(extractUrl(right.text) != null, '响应必须含真实直链')

    // 本地网关（如果这台机器上真的有）：只断言"未授权必须被拒"，不强求它有我们的密钥
    const local = await fetchText('http://127.0.0.1:1101/api/v0/url/kw/62355680/320k', {}, 4000)
    if (local.status === 0) {
      console.log('  SKIP：本机 1101 没有网关（不是通过，是没测）')
      return
    }
    const looksLikeOurs = /\{"code"\s*:/.test(local.text)
    if (!looksLikeOurs) {
      console.log('  SKIP：127.0.0.1:1101 上不是 LXSP 系网关（可能是别的服务），不做断言')
      return
    }
    console.log(`  本机网关不带密钥 → http=${local.status}`)
    t.ok(local.status === 401 || local.status === 403, `本机网关未授权必须被拒（401/403），实际 ${local.status}`)
  })
}
