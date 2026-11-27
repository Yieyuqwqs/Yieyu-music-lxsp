#!/usr/bin/env node
/**
 * 构建期注入「授权核对称密钥」（AUTHZ_SECRET_B64）。
 *
 * 为什么不能直接写死进仓库：本仓库是公开的，密钥一旦提交等于把签发权公开。
 * 客户端与管理端必须用同一把密钥，否则管理端写进 whitelist.json 的条目键
 * 客户端永远匹配不上。
 *
 * 用法：
 *   node scripts/write-authz-secret.js --gen        # 生成一把新密钥（打印 base64，只打印一次）
 *   AUTHZ_SECRET_B64=xxx node scripts/write-authz-secret.js            # 本地注入
 *   AUTHZ_SECRET_B64=xxx node scripts/write-authz-secret.js --require  # CI 用：缺失直接失败
 *
 * 注入目标：android/authz/src/main/cpp/authz_secret.h（XOR 掩码存放）
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const MASK = 0x5a
const requireSecret = process.argv.includes('--require')
const generate = process.argv.includes('--gen')
const out = path.join(__dirname, '..', 'android', 'authz', 'src', 'main', 'cpp', 'authz_secret.h')

if (generate) {
  const key = crypto.randomBytes(32)
  console.log(key.toString('base64'))
  console.log('# ↑ 存进 GitHub Secrets：AUTHZ_SECRET_B64（客户端与管理端共用同一把）')
  process.exit(0)
}

const readKey = () => {
  const hex = (process.env.AUTHZ_SECRET_HEX || '').trim()
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex')
  const b64 = (process.env.AUTHZ_SECRET_B64 || '').trim()
  if (!b64) return null
  const buf = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  return buf.length === 32 ? buf : null
}

const key = readKey()
if (key == null) {
  if (requireSecret) {
    console.error('[authz] 缺少 AUTHZ_SECRET_B64（32 字节 base64）：授权核密钥必须由 Secret 注入，拒绝构建')
    process.exit(1)
  }
  console.warn('[authz] 未提供 AUTHZ_SECRET_B64，沿用仓库内的 DEV 占位密钥（只能本地调试）')
  process.exit(0)
}

const masked = Array.from(key).map(value => value ^ MASK)
const rows = []
for (let i = 0; i < masked.length; i += 8) {
  rows.push('    ' + masked.slice(i, i + 8).map(value => '0x' + value.toString(16).padStart(2, '0') + 'u').join(', ') + ',')
}

const content = `// 自动生成（构建期注入）：授权核对称密钥，严禁提交真密钥
// 生成方式：node scripts/write-authz-secret.js --gen → 存 GitHub Secrets AUTHZ_SECRET_B64
#pragma once

#include <cstdint>

/** 32 字节对称密钥（XOR 掩码存放，运行时还原） */
static const uint8_t kAuthzKeyMasked[32] = {
${rows.join('\n')}
};
static constexpr uint8_t kAuthzKeyMask = 0x${MASK.toString(16).padStart(2, '0')}u;
`

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, content)
console.log('[authz] 已注入授权核密钥（32 字节）→ android/authz/src/main/cpp/authz_secret.h')
