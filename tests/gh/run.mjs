// GitHub 镜像候选回归（纯逻辑，不联网）
//
// 跑法：node --import ./tests/authz/hook.mjs tests/gh/run.mjs
import { ghUrlCandidates, ghDownloadCandidates } from '@/utils/ghMirror'

let failed = 0
const test = (name, fn) => {
  try {
    fn()
    console.log('  ✓ ' + name)
  } catch (error) {
    failed++
    console.error('  ✗ ' + name + '\n      ' + error.message)
  }
}
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}\n  期望: ${b}\n  实际: ${a}`)
}
const ok = (value, label) => { if (!value) throw new Error('断言失败: ' + label) }

const RAW = 'https://raw.githubusercontent.com/owner/repo/main/publish/version.json'
const API = 'https://api.github.com/repos/owner/repo/releases/latest'
const ASSET = 'https://github.com/owner/repo/releases/download/v1.0.0/app-arm64-v8a.apk'

console.log('镜像候选')

test('直连永远排第一', () => {
  t0(ghUrlCandidates(RAW)[0] === RAW)
  t0(ghUrlCandidates(API)[0] === API)
  t0(ghUrlCandidates(ASSET)[0] === ASSET)
})

test('raw：反代 + 镜像域名 + jsDelivr 都要有', () => {
  const list = ghUrlCandidates(RAW)
  ok(list.includes('https://gh-proxy.com/' + RAW), '缺 gh-proxy 反代')
  ok(list.includes('https://raw.gitmirror.com/owner/repo/main/publish/version.json'), '缺 gitmirror 镜像')
  ok(list.includes('https://cdn.jsdelivr.net/gh/owner/repo@main/publish/version.json'), '缺 jsDelivr')
})

test('api：只做反代 + api 镜像域名，不套 jsDelivr', () => {
  const list = ghUrlCandidates(API)
  ok(list.includes('https://gh-proxy.com/' + API), '缺 gh-proxy 反代')
  ok(list.includes('https://api.kkgithub.com/repos/owner/repo/releases/latest'), '缺 kkgithub api 镜像')
  ok(!list.some(item => item.includes('jsdelivr')), 'api 不该出现 jsDelivr')
})

test('下载：反代排在直连前面（国内直连 github.com 会卡死）', () => {
  const list = ghDownloadCandidates(ASSET)
  ok(list[0].startsWith('https://gh-proxy.com/'), '第一个候选必须是 gh-proxy 反代')
  ok(list[list.length - 1] === ASSET, '直连必须垫底')
  ok(list.includes('https://ghproxy.net/' + ASSET), '缺 ghproxy.net 反代')
})

test('候选不重复、不留空串', () => {
  for (const list of [ghUrlCandidates(RAW), ghUrlCandidates(API), ghDownloadCandidates(ASSET)]) {
    eq(new Set(list).size, list.length, '出现重复候选')
    ok(list.every(item => typeof item === 'string' && item.length > 0), '出现空候选')
  }
})

test('非 GitHub 地址原样返回（不去乱加反代）', () => {
  const url = 'https://example.com/a.json'
  eq(ghUrlCandidates(url), [url])
  eq(ghDownloadCandidates(url), [url])
})

function t0 (value) { if (!value) throw new Error('期望为真') }

console.log(failed === 0 ? '\n镜像候选回归全部通过' : `\n失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
