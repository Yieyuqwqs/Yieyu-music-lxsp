# 协议参考 · 房间消息与 LXSP 兼容层

---

## 一、房间消息（一起听，MQTT 载荷 JSON）

| 类型 | 方向 | 关键字段 | 说明 |
|---|---|---|---|
| `state` | 房主 → 全员 | `version` / `playback` / `queue` / `currentIndex` / `members` / `settings` | 完整状态；成员**只在 version 变化时**应用 |
| `control` | 房主 → 全员 | `PLAY`/`PAUSE`/`SEEK`/`SET_TRACK`/`SET_QUEUE`/`QUEUE_ADD`/`QUEUE_REMOVE`/`PLAYBACK_MODE` | 每个动作都会 bump version 并广播新 state |
| `request` | 成员 → 房主 | `REQUEST_PLAY`/`REQUEST_PAUSE`/`REQUEST_SEEK`/`REQUEST_SET_TRACK` | 成员无控制权，只能请求 |
| `SYNC_REQUEST` | 成员 → 房主 | `from` | 请求补发完整状态（加入房间时） |
| `hello` / `np_*` | 双向 | 时钟同步样本 | RTT 最小的样本用于估算 offset |

> **已废弃并删除**：`URL_SHARE`。跨设备分发直链会让成员 100% 拿到过期链接（实测 403/410）。

### 状态压缩字段（P2P 线上格式，`compactState`）

```
S: { t:'S', p:positionMs, a:anchorServerMs, i:isPlaying, k:trackStableKey,
     n:queueName?, ci:currentIndex, m:members, q:queue, mb:?, r:role, v:version }
```

---

## 二、LXSP v2（音源协议，网关侧）

### 2.1 响应包络

```json
{ "ok": true,  "data": { … } }
{ "ok": false, "error": { "code": "SOURCE_UNAVAILABLE", "message": "…" } }
```

13 个错误码：`BAD_REQUEST` / `UNAUTHORIZED` / `SOURCE_UNAVAILABLE` / `TRACK_NOT_FOUND` / `QUALITY_UNSUPPORTED` / `URL_EXPIRED` / `RATE_LIMITED` / `UPSTREAM_TIMEOUT` / `UPSTREAM_HTTP` / `PARSE_FAILED` / `PLUGIN_ERROR` / `INTERNAL` / `UNSUPPORTED_VERSION`

### 2.2 端点

```
GET  /api/v0/url/{source}/{id}/{quality}      逐曲取直链
GET  /api/v0/search?q=…&source=…              搜索
GET  /api/v0/manifest                         能力清单（manifest.endpoints / capabilities）
```

鉴权：`X-Api-Key: <key>` 或 `Authorization: Bearer <key>` 或 `?key=<key>`；无 key → **401**（必须保持可复现）。

### 2.3 四种历史脚本家族的兼容

| 家族 | 形态 |
|---|---|
| `lxsp` | 原生 v2（本节） |
| `lx-source` | `GET /api/v0/url/{source}/{id}/{quality}` + `X-Api-Key` |
| `api-wwwweb` | `POST /music/url {source,musicId,quality,name,singer}` |
| `api-json` | 旧 JSON 端点（settings 里填 URL + Key） |

---

## 三、直链生命周期（本次事故的核心）

- 酷我/酷狗等 CDN 直链**寿命几十分钟**，且与请求者 IP/时间相关
- 因此：**禁止缓存直链超过 5 分钟**、**禁止跨设备分发直链**
- 播放前不得依赖"上次解析的 URL"，必须重新解析
