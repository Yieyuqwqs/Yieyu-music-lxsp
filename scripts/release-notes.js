#!/usr/bin/env node
// 由 publish/version.json 生成 GitHub Release 说明（与 App 内公告同源）
const path = require('path')
const v = require(path.join(__dirname, '..', 'publish', 'version.json'))
const lines = [
  `**Yieyu Music v${v.version}** · 固定签名构建（同包名可直接覆盖升级）`,
  '',
  v.desc,
  '',
  '---',
  '',
  '**安装说明**：按 CPU 架构选择，`arm64-v8a` 是现代手机首选，不确定就下 `universal`。',
  '**包名变更**：本版 `com.yieyu.music`，首次安装请先卸载旧版（`cn.toside.music.mobile`）；此后版本可直接覆盖安装。',
]
console.log(lines.join('\n'))
