// 真机网络的联调脚本：验证「检查更新」这条链路在本机网络下真的能用
//
// 跑法：node --import ./tests/authz/hook.mjs tools/update-live-check.mjs
import { ghFetch, ghFetchRawText, ghDownloadCandidates } from '@/utils/ghMirror'

const OWNER = 'Yieyuqwqs'
const PUBLIC_REPO = 'Yieyu-Update'
const manifestUrl = `https://api.github.com/repos/${OWNER}/${PUBLIC_REPO}/contents/update.json?ref=main`

const step = async (name, fn) => {
  const started = Date.now()
  try {
    const result = await fn()
    console.log(`✓ ${name} (${Date.now() - started}ms) ${result ?? ''}`)
    return true
  } catch (error) {
    console.log(`✗ ${name} (${Date.now() - started}ms) ${error?.message ?? error}`)
    return false
  }
}

const main = async () => {
  let ok = true

  let manifest = null
  ok = await step('update.json（contents API → 反代兜底）', async() => {
    const text = await ghFetchRawText(manifestUrl, { timeoutMs: 8000 })
    manifest = JSON.parse(text)
    return `${manifest.latestVersion} / versionCode ${manifest.versionCode}`
  }) && ok

  let release = null
  ok = await step('releases/latest（多镜像赛跑）', async() => {
    const { url, data } = await ghFetch(`https://api.github.com/repos/${OWNER}/${PUBLIC_REPO}/releases/latest`, {
      timeoutMs: 8000,
      validate: data => Array.isArray(data?.assets) && data.assets.length > 0,
    })
    release = data
    return `${data.tag_name} · ${data.assets.length} 个资产 · 命中 ${url}`
  }) && ok

  if (release) {
    const asset = release.assets.find(item => item.name.includes('universal')) ?? release.assets[0]
    const candidates = ghDownloadCandidates(asset.browser_download_url)
    console.log('  下载候选：\n' + candidates.map((url, index) => `    ${index + 1}. ${url}`).join('\n'))
    ok = await step('第一个加速地址真的能下（Range 取 1KB）', async() => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10000)
      try {
        const res = await fetch(candidates[0], { headers: { Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal })
        const bytes = (await res.arrayBuffer()).byteLength
        if (!(res.ok || res.status === 206) || bytes < 100) throw new Error(`HTTP ${res.status} / ${bytes} bytes`)
        return `${res.status} · ${bytes} bytes · ${res.headers.get('content-type')}`
      } finally {
        clearTimeout(timer)
      }
    }) && ok
  }

  console.log(ok ? '\n检查更新链路在本机网络下可用 ✅' : '\n有环节失败 ❌')
  process.exit(ok ? 0 : 1)
}

void main()
