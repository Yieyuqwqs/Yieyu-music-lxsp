#!/usr/bin/env node
// CI 专用：切换构建变体（client / admin）
// 注意：这里会同时重写 index.js，让入口只 require 一个分支，
// 否则 Metro 会把管理端界面（含黑名单管理、私钥占位）也打进客户端包里。
const fs = require('fs')
const path = require('path')
const variant = process.argv[2] === 'admin' ? 'admin' : 'client'
const root = path.join(__dirname, '..')

const variantFile = path.join(root, 'src', 'config', 'variant.ts')
fs.writeFileSync(variantFile, `// 构建变体：client（Yieyu Music）或 admin（Yieyu Admin）\nexport const APP_VARIANT: 'client' | 'admin' = '${variant}'\n`)

const entryFile = path.join(root, 'index.js')
const target = variant === 'admin' ? '@/appAdmin' : '@/app'
fs.writeFileSync(entryFile, `/**
 * @format
 */
import './shim'
import { APP_VARIANT } from '@/config/variant'

console.log('[Yieyu] variant =', APP_VARIANT)

// 同步加载：RNN 的 app launched 事件需要先完成组件注册
// 入口由 scripts/set-variant.js 按构建变体生成，另一个分支不会被 Metro 打进包里
require('${target}')
`)

// ---------------------------------------------------------------------------
// 变体物理隔离（管理端绝不带悬浮窗 / 局域网传歌）
// 只做「注册层」摘除 + Manifest 权限摘除：共享源码树不能删类（客户端还要用），
// 但管理端包里不再有任何一行 Java 去 new OverlayPackage() / LanSharePackage()，
// 也不再有 SYSTEM_ALERT_WINDOW 权限 → 系统层面就挂不上悬浮窗。
// ---------------------------------------------------------------------------
const targets = [
  path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  path.join(root, 'android', 'app', 'src', 'main', 'java', 'cn', 'toside', 'music', 'mobile', 'MainApplication.java'),
]

const backupOf = (file) => file + '.variant-backup'

const stripManifest = (source) => {
  let out = source
  // 1) 摘掉悬浮窗权限（管理端不该出现在「显示在其他应用上层」列表里）
  out = out.replace(/[ \t]*<uses-permission android:name="android\.permission\.SYSTEM_ALERT_WINDOW" \/>[ \t]*\r?\n/g, '')
  // 2) 摘掉任何 overlay / widget / lanshare 组件（当前没有，防御性处理）
  out = out.replace(/[ \t]*<(service|receiver|activity)([^>]*?)(\/>|>[\s\S]*?<\/\1>)/gi, (match, tag, attrs, rest) => {
    if (/(overlay|widget|lanshare)/i.test(attrs)) return ''
    return match
  })
  if (/overlay|lanshare/i.test(out)) throw new Error('[variant] 管理端 Manifest 仍残留 overlay/lanshare 声明，构建中止')
  return out
}

const stripMainApplication = (source) => {
  let out = source
  // 摘掉注册行（保留空的变体判断块，javac 允许空块，避免手写括号匹配出错）
  out = out.replace(/^[ \t]*packages\.add\(new (OverlayPackage|LanSharePackage)\(\)\);[ \t]*\r?\n/gm, '')
  if (/packages\.add\(new (OverlayPackage|LanSharePackage)\(\)\)/.test(out)) {
    throw new Error('[variant] MainApplication 仍注册 Overlay/LanShare，构建中止')
  }
  return out
}

const applyVariant = () => {
  for (const file of targets) {
    if (!fs.existsSync(file)) continue
    const backup = backupOf(file)
    if (variant === 'admin') {
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
      const base = fs.existsSync(backup) ? backup : file
      const source = fs.readFileSync(base, 'utf8')
      const stripped = /AndroidManifest\.xml$/.test(file) ? stripManifest(source) : stripMainApplication(source)
      fs.writeFileSync(file, stripped)
      console.log('🧱 管理端已剥离：' + path.relative(root, file))
    } else if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, file)
      fs.unlinkSync(backup)
      console.log('🧱 客户端已恢复：' + path.relative(root, file))
    }
  }
}

applyVariant()

console.log('✅ 构建变体 ->', variant, '（入口 index.js ->', target + '）')
