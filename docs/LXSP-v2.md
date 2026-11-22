# LXSP v2 · 落雪音乐统一音源协议

> 状态：**现行标准（Aurora 线）**。客户端实现见 `src/core/source/`，线格式类型见 `src/types/lxsp.d.ts`，
> 参考服务端实现见本地网关 `lx-server/lxsp.js`（Rust 网关按 §11 映射即可）。
> 这把尺子只量一件事：**一个音源要么符合协议，要么不存在**。

---

## 0. 为什么废掉旧的自定义源脚本

旧模型（v1 custom source）的每一个问题，最后都变成用户的「放不出声」，而且是没法解释的那种：

| 旧模型的做法 | 后果 |
| --- | --- |
| 每个源是一段任意 JS，跑在 native 沙箱里，通过 `request`/`response` 事件和宿主通信 | 每个脚本自己解释协议；宿主只能 `try/catch` 猜它到底支持什么 |
| 能力靠脚本自己在 `info.sources[source].actions` 里手写 | `actions:['url']` 的源也可能对 `getLyric` 返回 `undefined`，客户端无法在调用前判断 |
| 音质是自由字符串（`sq`/`hq`/`hires`/`lossless`/`320k` 混用） | 降档逻辑写死在客户端一堆 `if` 里，跨源必有 bug |
| 错误只是 `{status:false, errorMessage:'失败'}` | 无法区分「版权没有」和「网关超时」，换源/降档只能瞎试 |
| 脚本 = 代码，来源不明、可以 `request` 任意 URL | 供应链风险，且每次改逻辑都要用户重新导入脚本 |
| 内置 5 个源、每个第三方脚本、每个自建网关各写一套接口 | 同一个功能 N 份实现，改动要同步 N 次 |

LXSP v2 把这六件事分别改成：**声明式 manifest、能力矩阵、封闭音质词汇、封闭错误码、无代码执行、单一协议**。

一句话：**音源不再是一段代码，而是一个符合本文件的 HTTP 服务。**

---

## 1. 设计原则（规范性）

1. **无代码执行**：客户端不加载、不解析、不执行任何音源提供的代码。音源只能通过 HTTP JSON 表达自己。
2. **声明即契约**：能力必须在 `manifest` 里声明；未声明的能力，客户端不得调用。
3. **词汇封闭**：音源键、音质、错误码是封闭集合。服务端自有词汇必须在出口前归一（§4.2）。
4. **降级必须显式**：任何低于请求音质的结果，都必须带 `downgraded: true`。静默降级视为不合规。
5. **失败必须可解释**：所有失败都要落到 §4.3 的错误码；客户端行为只由错误码驱动，不由文案或 HTTP 状态码驱动。
6. **前向兼容**：客户端必须忽略未知字段、跳过未知能力；服务端必须忽略未知查询参数。
7. **幂等可缓存**：`GET` 请求不得有副作用；直链有效期用 `expiresAt` / `limits.urlTtlS` 表达。

---

## 2. 角色与部署形态

```
┌────────────┐   LXSP v2 (HTTP/JSON)   ┌──────────────┐
│  LX 客户端  │ ──────────────────────▶ │  音源提供方   │ ──▶ 上游音乐平台
│ (手机 App)  │ ◀────────────────────── │ (Provider)   │
└────────────┘      信封/错误码/音质      └──────────────┘
```

* **Provider（音源提供方）**：一个 HTTP 服务，有唯一 `provider.id`，可提供 1~5 个音源（`kw/kg/tx/wy/mg`）。
* **Endpoint（端点）**：Provider 的一个部署地址。同一 Provider 的多个端点视为镜像，`provider.id` 相同。
* **Source（音源）**：`kw | kg | tx | wy | mg | local`，沿用 LX 既有词汇。
* **Provider 优先级**：客户端按「健康度 → 配置顺序」排序，配置顺序即用户的意图，不许客户端自己乱排。

---

## 3. 传输与信封

* 协议版本：`lxsp: "2.x"`。主版本不符 → 客户端必须拒绝该端点。
* 编码：`application/json; charset=utf-8`；`GET` 请求，无请求体。
* 鉴权：`Authorization: Bearer <token>`（默认），也允许 `auth.scheme = "header" | "query"` 自定义。
* 客户端应带 `X-Lxsp-Version: 2.0`，服务端可忽略。
* 超时：客户端默认 12s（解析）/ 8s（manifest）/ 15s（搜索）；服务端 `limits.timeoutMs` 只能更严。

### 3.1 成功

```json
{ "ok": true, "data": { ... }, "trace": "lx_mws1eifn" }
```

### 3.2 失败

```json
{
  "ok": false,
  "error": {
    "code": "upstream_denied",
    "message": "该曲目需要 VIP",
    "retryable": false,
    "source": "kw",
    "quality": "flac",
    "upstream": "kugou:101404"
  }
}
```

HTTP 状态码规则：**业务失败一律 `200` + `ok:false`**。
`401/403/404/429/5xx` 只用于传输层语义（鉴权失败、路由不存在、限流、网关故障），客户端会在缺省错误码时按状态码兜底映射。

---

## 4. 词汇表（封闭）

### 4.1 音源键

`kw`（酷我） `kg`（酷狗） `tx`（QQ） `wy`（网易云） `mg`（咪咕） `local`（本地文件）

### 4.2 音质

权威阶梯（从高到低），**顺序是协议的一部分**：

```
master > atmos_plus > atmos > flac24bit > wav > flac > ape > 320k > 192k > 128k
```

服务端自有词汇必须在出口前归一，别名表（客户端同样接受这些输入）：

| 服务端可能写的 | 规范词汇 |
| --- | --- |
| `hires` `hi_res` `24bit` `lossless_24bit` | `flac24bit` |
| `lossless` `sq` | `flac` |
| `hq` `high` | `320k` |
| `std` `standard` `low` | `128k` |
| `dolby` | `atmos` |
| `192` `128` `320`（纯数字） | `192k` `128k` `320k` |

> 本机网关当前把 `hires` 出口成 `flac24bit`，把 `wav/ape` 就近映射到 `flac`，`192k` 映射到 `320k` —— 映射关系集中在一处（`lx-server/lxsp.js` 顶部），不允许散落。

### 4.3 错误码与客户端处置

| code | 含义 | 可重试 | 同源降档 | 换源/换镜像 | 标记坏源 |
| --- | --- | --- | --- | --- | --- |
| `unsupported` | 该能力/音源未实现 | 否 | 否 | 是 | 否 |
| `not_found` | 上游确认无此曲 / id 无效 | 否 | 否 | 是 | 否 |
| `quality_unavailable` | 该档不可得 | 否 | **是** | 否 | 否 |
| `upstream_denied` | 版权/VIP/地区/风控 | 否 | 是 | 是 | 否 |
| `upstream_error` | 上游 5xx / 解析失败 | 是 | 是 | 是 | 否 |
| `rate_limited` | 被限流（可带 `retryAfterMs`） | 是 | 否 | 是 | 是 |
| `unauthorized` | 提供方鉴权失败 | 否 | 否 | 是 | 是 |
| `timeout` | 超时 | 是 | 否 | 是 | 是 |
| `network` | 连接类错误 | 是 | 否 | 是 | 是 |
| `bad_request` | 参数不合法（客户端 bug） | 否 | 否 | 否 | 否 |
| `bad_response` | 响应不符合协议 | 否 | 否 | 是 | 是 |
| `canceled` | 客户端主动取消 | 否 | 否 | 否 | 否 |
| `internal` | 服务端内部错误 | 是 | 否 | 是 | 是 |

「换源/换镜像」= 立刻放弃当前端点，不在同一端点上继续烧降档（网络类错误降档没有意义）。

---

## 5. 路由

路由默认挂在端点根路径；`manifest.endpoints` 可以覆盖任意一条。

| 方法 | 路径 | 能力 | 说明 |
| --- | --- | --- | --- |
| GET | `/manifest` | （必需） | 能力声明 |
| GET | `/url/{source}/{id}` | `url` | 取直链（核心） |
| GET | `/lyric/{source}/{id}` | `lyric` | 取歌词 |
| GET | `/pic/{source}/{id}` | `pic` | 取封面 |
| GET | `/search` | `search` | 搜索（支持多源聚合） |
| GET | `/playlist/{source}/{id}` | `playlist` | 歌单 |
| GET | `/chart/{source}/{id}` | `chart` | 榜单 |
| GET | `/stream/{token}` | `stream` | 媒体代拉（Range/206） |
| GET | `/healthz` | （建议） | 健康探测 |

### 5.1 `/manifest`

```json
{
  "ok": true,
  "data": {
    "lxsp": "2.0",
    "provider": { "id": "yieyu-local", "name": "Yieyu 本地音源网关", "version": "1.0.0" },
    "auth": { "required": true, "scheme": "bearer" },
    "capabilities": ["url", "lyric", "pic", "search"],
    "features": { "streamProxy": false, "crossSource": true, "multiSource": true },
    "limits": { "timeoutMs": 25000, "maxPageSize": 50, "urlTtlS": 600 },
    "sources": [
      { "key": "kw", "name": "酷我音乐", "qualities": ["320k", "128k"], "capabilities": ["url", "lyric", "search"] },
      { "key": "wy", "name": "网易云音乐", "qualities": ["flac24bit", "flac", "320k", "128k"] }
    ]
  }
}
```

校验规则（客户端必须硬失败，不许猜）：

* `lxsp` 主版本必须为 `2`；
* `provider.id`、`provider.name` 必填；
* `sources` 非空，`key` 必须属于 §4.1，不得重复；
* 每个 source 归一并去重后**至少要有 1 个可识别音质**；
* `source.capabilities` 缺省时继承 `manifest.capabilities`。

### 5.2 `/url/{source}/{id}`

查询参数（除 `quality` 外都是可选的搜索纠偏信息）：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `quality` | 音质或 `auto` | 期望音质 |
| `name` / `singer` / `album` | string | 供上游纠偏、跨平台兜底 |
| `duration` | 毫秒 | 同上 |
| `fallback` | `0`/`1` | 允许服务端跨平台兜底（需 `features.crossSource`） |

响应：

```json
{
  "ok": true,
  "data": {
    "url": "https://cdn/xxx.flac",
    "streamUrl": "https://gw/stream/abc",
    "source": "kw", "id": "62355680",
    "quality": "320k",
    "requestedQuality": "flac",
    "downgraded": true,
    "expiresAt": 1800000000,
    "detail": { "format": "mp3", "bitrateKbps": null },
    "via": { "upstream": "agg-wwwweb", "cache": "l1", "coalesced": false }
  }
}
```

* `url` 必须是 `http(s)` 直链；`streamUrl` 存在时客户端优先使用（防外链、可续传）。
* `quality` 必填且属于 §4.2；`downgraded` 由服务端声明，客户端**仍会复核**（服务端漏报 → 客户端补报）。
* `via` 是观测字段：缓存层级、上游实现、是否被合并，便于排障。

### 5.3 `/lyric/{source}/{id}`

```json
{ "ok": true, "data": { "lrc": "[00:01.00]…", "tlrc": null, "rlrc": null, "lxlrc": null, "format": "lrc" } }
```

`lrc` 必填且非空；无歌词返回 `not_found`（**不要返回空字符串当成功**）。

### 5.4 `/pic/{source}/{id}`

```json
{ "ok": true, "data": { "url": "https://cdn/cover.jpg", "width": 300, "height": 300 } }
```

### 5.5 `/search`

| 参数 | 说明 |
| --- | --- |
| `q` | 关键词（必填） |
| `page` / `limit` | 页码（从 1 开始）/ 每页条数（`limit ≤ limits.maxPageSize`） |
| `sources` | 逗号分隔的音源键；缺省 = 该 Provider 全部音源 |

```json
{
  "ok": true,
  "data": {
    "items": [{ "id": "5257138", "name": "屋顶", "singer": "周杰伦/温岚/吴宗宪",
                "album": "…", "durationMs": null, "coverUrl": null,
                "qualities": { "flac": { "size": 30000000 } } }],
    "page": 1, "limit": 20, "total": 4, "hasMore": false, "sources": ["kw", "wy"]
  }
}
```

单条脏数据（缺 `id`/`name`）必须被丢弃，不得让整页失败。

---

## 6. 客户端解析算法（规范性）

```
resolveUrl(source, id, wantQuality):
  providers ← registry.providersFor(source, 'url')      # 健康者在前，其次 priority 升序
  if providers 为空: raise unsupported
  lastError ← null
  for p in providers:
    candidates ← pickCandidates(wantQuality, p.qualities)   # 规范阶梯降档，不越权升档
    for q in candidates:
      try:  v ← singleflight(p, source, id, q).resolve(...)
            if isDowngrade(wantQuality, v.quality): v.downgraded ← true
            remember(source, name, singer); return v
      catch e:
            if e.code in (canceled, bad_request): raise e
            if policy.markBad: markUnhealthy(p, e.code, 60s)
            if policy.nextProvider: break   # 换镜像，不再降档
            if not policy.nextQuality: break
  raise lastError or not_found
```

不变式：

* **单飞**：同一 `(provider, source, id, quality)` 的并发请求只打一次上游。
* **不静默降级**：返回结果的 `downgraded` 必须如实反映「实际音质 < 请求音质」。
* **不无脑重试**：`unauthorized`/`bad_response` 重试同一端点没有意义，直接换。
* **冷却**：坏源进入 60s 冷却，但**不删除**（所有源都坏时它仍是最后一根稻草）。
* **禁止递归**：内置源适配器不得声明 `url` 能力（否则 `apis() → resolver → 内置源` 成环）。

---

## 7. 一致性等级

| 等级 | 要求 |
| --- | --- |
| **Core** | `/manifest` + `/url` + 正确的 §4.2/§4.3 词汇，且 `downgraded` 如实 |
| **Full** | Core + `/lyric` + `/pic` + `/search`，且能力逐源声明 |
| **Stream** | Full + `/stream`（`Range`/`206`/`Accept-Ranges`/`HEAD`） |

验收清单（端到端，缺一不可）：

1. `GET /manifest` 能通过 §5.1 全部校验；
2. 请求 `flac` 而只有 `320k` 时，返回 `quality=320k` 且 `downgraded=true`；
3. 无版权曲目返回 `upstream_denied`，而不是 `not_found`；
4. 直链失效（上游 403）返回 `upstream_error`，客户端换镜像后能成功；
5. `/search` 单条脏数据不影响整页；
6. 慢端点（>超时）被 `timeout` 收口，不悬挂；
7. 无 token 访问受保护路由返回 401 + `unauthorized`。

---

## 8. 安全

* 非 loopback 端点必须 `https`；`http` 仅允许 `127.0.0.1` / `::1` / 局域网明文调试。
* Token 存本地设置，不写日志、不进播放历史。
* 服务端做 SSRF 防护：不得把客户端参数当 URL 直接请求。
* 服务端应对响应体做大小上限（建议 2MB）与上游超时（建议 ≤ 服务端 deadline）。
* **客户端永不执行 Provider 提供的任何代码** —— 这是 v2 存在的根本理由。

---

## 9. 版本演进

* `2.x`：只加字段、加能力、加错误码（客户端必须忽略未知项）。
* `3.0`：破坏性变更（改信封/改语义/删错误码）。
* 客户端必须拒绝 `lxsp` 主版本 ≠ 2 的端点，并在设置页明示原因（`unsupported lxsp version`）。

---

## 10. v1 脚本 → v2 映射

| v1（自定义源脚本） | v2（LXSP） |
| --- | --- |
| 导入 `.js` 文件 | 配置端点 URL + token |
| `info.sources[source].actions` | `manifest.sources[].capabilities` |
| `info.sources[source].qualitys` | `manifest.sources[].qualities` |
| `lx.on('request', {action:'musicUrl'})` | `GET /url/{source}/{id}` |
| 返回 `{status:false, errorMessage}` | `{ ok:false, error:{ code } }` |
| 脚本内 `request()` 任意 URL | 服务端自己的出网逻辑（客户端不管） |
| 每次更新要用户重新导入脚本 | 服务端升级，客户端无感 |

客户端迁移策略：检测到历史脚本时**只做提示与清理**，不执行；`common.enableUserApiScripts` 保留为逃生开关（默认 `false`）。

---

## 11. 落地位置

| 层 | 位置 |
| --- | --- |
| 线格式类型 | `src/types/lxsp.d.ts` |
| 常量与词汇表 | `src/core/source/protocol.ts` |
| 音质归一/降档 | `src/core/source/quality.ts`（唯一实现） |
| 错误码与处置 | `src/core/source/errors.ts` + `protocol.ts: ERROR_POLICY` |
| 信封传输 | `src/core/source/transport.ts` |
| manifest 校验 | `src/core/source/manifest.ts` |
| 远端 Provider | `src/core/source/remote.ts` |
| 内置源兜底 | `src/core/source/local.ts`（无 `url` 能力） |
| 注册表/健康度 | `src/core/source/registry.ts` |
| 解析流水线 | `src/core/source/resolver.ts` |
| 引擎与旧调用面兼容 | `src/core/source/engine.ts`、`src/core/apiSource.ts` |
| 参考服务端 | 本地网关 `lx-server/lxsp.js`（挂载于 `server.js`，位于 `/api/v0` 之前） |
| 回归测试 | `tests/lxsp/`（`node --import ./tests/lxsp/hook.mjs tests/lxsp/run.mjs`） |
| 真机联调 | `tools/lxsp-live.mjs` |

Rust 网关（`audio-parse-gateway`）接入建议：把 `src/app.rs` 的路由替换为 §5 的 `/manifest`、`/url/{source}/{id}`、`/lyric`…`/search`，
出口处统一做「错误码归一 + 音质别名归一」，内部 `Upstream` trait 与缓存/单飞保持不动 —— 协议层是薄壳，不该动摇已有性能设施。
