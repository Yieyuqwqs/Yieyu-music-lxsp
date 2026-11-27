# 检查更新 / 下载加速（国内网络）

## 症状与根因

「设置 → 软件更新」一直停在「正在检查更新…」，按钮点不动。

根因是两条：

1. **请求打到了私有仓库和国内不通的域名**
   旧版 `src/utils/version.js` 读的是私有仓库 `Yieyu-music` 的 `publish/version.json`，
   `src/core/update.ts` 读的是同一个私有仓库的 `releases/latest` → 匿名请求必然 404；
   再加上 `raw.githubusercontent.com` / `github.com` 在国内经常「连得上但永不返回」，
   于是请求一直挂着。
2. **fetch 没有超时**
   `checkUpdate` 里没有任何超时兜底，界面状态就永远停在 `checking`。

## 现在的结构

```
用户操作            调用                            命中
────────────────────────────────────────────────────────────────────────
软件更新按钮   core/update.ts#checkAndInstallUpdate  utils/version#getLatestRelease
版本弹窗       core/version.ts#checkUpdate          utils/version#getVersionInfo
下载 APK       utils/version#downloadApk            ghDownloadCandidates（加速）
```

`src/utils/ghMirror.ts` 是唯一出口：

* `ghUrlCandidates(url)`：把同一个地址展开成
  直连 → `gh-proxy.com` / `ghproxy.net` / `ghfast.top` 反代 → `kkgithub` / `raw.gitmirror.com` 镜像 → jsDelivr（仅 raw）
* `ghFetch(url)`：**并发赛跑**，第一个合法结果即返回；每个候选都有 6~8 秒硬超时
* `ghFetchRawText(url)`：读仓库文件专用，默认带 `Accept: application/vnd.github.raw`，
  反代把响应变成 contents 信封时会自动 base64 解码
* `ghDownloadCandidates(url)`：APK 下载候选，**反代在前、直连垫底**

## 数据放哪

| 文件 | 仓库 | 读法 |
| --- | --- | --- |
| `update.json`（强更清单） | `Yieyuqwqs/Yieyu-Update`（public） | contents API |
| `whitelist.json` / `blacklist.json`（授权名单） | `Yieyuqwqs/Yieyu-Update`（public） | contents API |
| Release APK | `Yieyuqwqs/Yieyu-Update` Releases | `gh-proxy.com/<asset>` 加速 |

私有仓库（`Yieyu-music`、`Yieyu-music-lxsp`）里的文件**不能**作为运行时数据源：
客户端是匿名请求，一定会 404。

## 本机实测（2026-11，移动网络）

| 地址 | 结果 |
| --- | --- |
| `api.github.com` 直连 | ✅ ~0.9s |
| `raw.githubusercontent.com` 直连 | ❌ 8s 超时 |
| `github.com` 的 Release 资产 | ❌ 8s 超时 |
| `gh-proxy.com` 反代 API | ✅ ~4s（有时比直连还快） |
| `gh-proxy.com` 反代 APK（Range 1KB） | ✅ 206 / 0.6s |
| `ghproxy.net` 反代 | ✅ 但慢（7s+） |
| `jsDelivr` / `ghfast.top` / `kkgithub` / `gitmirror` | ❌ 不通 |

联调脚本：`node --import ./tests/authz/hook.mjs tools/update-live-check.mjs`

## 兜底约定

* 检查更新：15 秒总时限，超时一定落成「检查更新失败」，按钮可以再点（不会永久卡死）。
* 下载：按候选顺序逐个试，全部失败才报错；失败会提示可以再试。
* 强更（force update）：也走 App 内加速下载，不再打开 `github.com` 下载页。
