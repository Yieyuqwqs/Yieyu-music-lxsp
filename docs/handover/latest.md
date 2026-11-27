# 交接报告（本轮真实输出）

生成时间：2026-11-27T22:12:27Z

## 交付物（已上线，实测）

- Release：`v1.9-Aurora-75`（本仓库 + 公库 Yieyu-Update 各 5 个客户端 APK）
- 公库强更清单：`latestVersion 1.9-Aurora-75 / versionCode 80`，`minSupportedVersion 1.9-Aurora-62` 保持不变
- CI：`CI (tests + constitution)` 在 GitHub runner 上全绿（含真链路）
- 构建：`Build APK` 成功（Client + Admin），固定签名指纹校验通过

## 声明与来源

| 声明 | 来源 | 证据命令 |
|---|---|---|
| 存储三层一致 + 有界缓存 | 实测 | tests/lxsp/storage.test.mjs · kv-cache.test.mjs |
| 端点探测竞速 / 并行探测 / 并行 init / 去重 | 实测 | tests/lxsp/source-engine.test.mjs |
| 取消通道贯通（canceleFn） | 实测 | tests/lxsp/source-engine.test.mjs |
| 换源/搜索失败原因可见 | 实测 | tests/lxsp/attempt-errors.test.mjs |
| 下载目录回退可见 / 同步鉴权坏 JSON 有兜底 | 实测 | tests/lxsp/attempt-errors.test.mjs（结构契约） |
| src 全量 610 个 .ts/.tsx 可解析 | 实测 | tests/lxsp/modules.test.mjs |
| APK 构建 + 双 Release 发版 | 实测 | Actions run 46032791420 |
| 真机运行（播放/搜索/下载/一起听） | 未接上 | 本机无 JDK/SDK/设备 |

## 测试套件（真实输出）

```

全绿：80 通过 / 0 失败（共 80）

授权协议回归全部通过

镜像候选回归全部通过
```

## 分支审计 + 宪法自检

```
条件分支审计：文件 18 个，if 共 220 处
分类：boundary 29 / flow 156 / invariant 35
硬违规：0
[PASS] 第 1 条 禁止补丁式开发  —  硬违规=0
[PASS] 第 3 条 状态只有一个来源（契约测试）  —  80 通过 / 0 失败
[PASS] 第 4 条 引用必须验证（定义/import/调用）  —  80 通过 / 0 失败
[PASS] 第 10 条 CI 解析到每个模块  —  modules.test.mjs 已包含在套件里且全绿
[PASS] 第 11 条 真实链路（非温室测试）  —  真实直链已验证：api-wwwweb kw → 4096 字节，type=audio/mpeg
[PASS] 第 5 条 性能改动带实测（基准可运行）  —  取直链·并发 3 次（单飞）                      0ms | (node:28209) ExperimentalWarning: stripTypeScriptTypes is an experimental feature and might change at any time | (Use `libdshnode.so --trace-warnings ...` to show where the warning was created)
[N/A] 第 6 条 构建失败只修根因  —  本机没有 JDK/Android SDK，无法执行 gradle；APK 构建需在 CI 或开发机验证
[PASS] 第 7 条 不留临时方案（源码无 TODO）  —  src 下 TODO/FIXME = 0（历史项已迁到 docs/KNOWN-LIMITATIONS.md）
[PASS] 第 8 条 诚实高于好看（status.json）  —  17 条声明，来源与证据齐全
[N/A] 第 9 条 改动清单纪律  —  人工条款：本轮改动清单见交付报告（先清单后代码）
[N/A] 第 12 条 不把锅甩给人类  —  人工条款：报告体例由交付报告保证
[PASS] 第 13 条 自检条款  —  本脚本存在并可执行
[PASS] 第 14 条 CI 必须跑测试  —  lxsp=true authz=true audit=true

结论：10 PASS / 0 FAIL / 0 WARN / 3 N/A
```

## 本轮改动

- 失败原因可见化：AllSourcesFailedError（URL/封面/歌词三条换源链）
- 多源搜索全挂 → 抛错，不再空列表
- 下载目录：回退原因可见（下载页）、ensureDir 带原因、Android 13+ 不再申请失效权限
- 同步鉴权坏 JSON → authFailed + 日志
- 结构契约测试 4 条（防 console.log 吞错误回归）
- 版本 1.9-Aurora-75 / versionCode 80，已发版到公库

## 还没做（事实）

- 真机运行验证（本机无设备）
- console.* 568 处未分级、启动字典/主题未懒加载（批次 C 性能项）
- targetSdk 仍是 29；升级需要 MediaStore/SAF 迁移，属于单独任务
- 双轨音源（搜索走 legacy、播放走 LXSP）未统一
