#!/usr/bin/env node
// 生成强更清单 update.json（唯一真源 = package.json + publish/version.json）
//
// 用法：
//   node scripts/publish-update-manifest.js public  [输出路径]   # 公库 Yieyu-Update（CI 自动发版用）
//   node scripts/publish-update-manifest.js private [输出路径]   # 主仓库兜底（默认写回 update.json）
//
// 设计：版本号只从 package.json 取，说明只从 publish/version.json 取，
// 这样「推代码 -> CI -> 公库清单」永远和这一版同源，不会再出现清单落后两个版本的情况。
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const ver = JSON.parse(fs.readFileSync(path.join(root, 'publish', 'version.json'), 'utf8'))

const version = String(pkg.version || '').trim()
const versionCode = Math.floor(Number(pkg.versionCode) || 0)
if (!version) throw new Error('package.json 缺少 version')
if (!versionCode) throw new Error('package.json 缺少 versionCode')

const channel = process.argv[2] === 'private' ? 'private' : 'public'
const owner = 'Yieyuqwqs'
const repo = channel === 'private' ? 'Yieyu-music' : 'Yieyu-Update'
const out = process.argv[3] || (channel === 'private' ? path.join(root, 'update.json') : '-')

// 强更弹窗文案优先用 version.json 里手写的短句（release notes 仍用完整 desc）
const message = String(ver.message || '').trim() || String(ver.desc || '')
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  .join(' · ')

/**
 * SOFT_RELEASE=1：软发布 —— 只把 latestVersion 顶到新版本，
 * minSupportedVersion 沿用线上现值（不强制老用户升级）。
 *
 * 为什么需要：Aurora-63 及以前的强更弹窗只会打开 github.com 的下载页，
 * 国内打不开 → 一旦把 minSupportedVersion 顶上去，老用户会被锁死在弹窗上。
 */
const softRelease = process.env.SOFT_RELEASE === '1'

const readLiveManifest = async () => {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/update.json`
  const res = await fetch(url, { headers: { 'User-Agent': 'Yieyu-music-release' } })
  if (!res.ok) throw new Error('读取线上 update.json 失败：HTTP ' + res.status)
  return res.json()
}

const build = async () => {
  let minSupportedVersion = version
  let minVersionCode = versionCode
  if (softRelease) {
    const live = await readLiveManifest()
    if (live && live.minSupportedVersion) minSupportedVersion = String(live.minSupportedVersion)
    if (live && Number.isFinite(Number(live.minVersionCode))) minVersionCode = Number(live.minVersionCode)
    process.stderr.write(`[soft] 保留最低版本 ${minSupportedVersion} / ${minVersionCode}\n`)
  }

  const manifest = {
    minSupportedVersion,
    latestVersion: version,
    downloadUrl: `https://github.com/${owner}/${repo}/releases/latest`,
    message,
    versionCode,
    minVersionCode,
  }

  const json = JSON.stringify(manifest, null, 2) + '\n'
  if (out === '-') process.stdout.write(json)
  else {
    fs.writeFileSync(out, json)
    process.stderr.write(`wrote ${out}: ${version} / ${versionCode} -> ${manifest.downloadUrl}\n`)
  }
}

void build().catch(error => {
  process.stderr.write(String(error?.message ?? error) + '\n')
  process.exit(1)
})
