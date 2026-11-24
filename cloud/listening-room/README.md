# 一起听房间服务（Cloudflare Workers + Durable Object）

一个房间一个 `ListeningRoomDO`：同步「放什么、放到哪」，**音频永远不经过服务端**。

```
Client A ─┐                        ┌─ DO(ListeningRoomDO) ─┐
Client B ─┼── WebSocket ──────────▶│ 锚点 / 队列 / 成员 / 权限 │
Client C ─┘                        └───────┬──────────────┘
                                          │ ctx.storage（持久化房间状态）
```

## 部署（两种方式，任选）

**方式 A：不需要 npm / wrangler**

```bash
CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy node deploy.mjs
```
Token 权限：`Workers Scripts: Edit`（模板「Edit Cloudflare Workers」）。
脚本会构建 → 上传（含 DO 绑定与 `new_sqlite_classes` 迁移）→ 打开 workers.dev 子域 → 冒烟（建房/加入/快照）→ 打印地址。

**方式 B：用 wrangler**

```bash
npx wrangler login
npx wrangler deploy
```

部署完把 `https://<name>.<你的子域>.workers.dev` 填进 App：**设置 → 一起听 → 服务器地址**。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/rooms` | 建房 → `{ roomId }` |
| POST | `/api/rooms/:id/join` | 加入 → `{ memberId, role, memberSecret, wsUrl }` |
| GET | `/api/rooms/:id/state` | 快照 → `{ state, serverNow }` |
| POST | `/api/rooms/:id/leave` | 显式离开 |
| GET | `/api/rooms/:id/ws?memberId=&memberSecret=` | WebSocket 升级 |

信封统一 `{ ok: true, data }` / `{ ok: false, error: { code, message } }`。

## 同步模型（关键）

房间状态里只有锚点：

```jsonc
"playback": { "positionMs": 30000, "anchorServerMs": 1700000000000, "isPlaying": true, "trackStableKey": "kw:42" }
```

- **PLAY / SEEK / SET_TRACK**：`anchorServerMs = serverNow + 400`（给网络留提前量）
- **PAUSE**：`anchorServerMs = serverNow`，`positionMs` 定格在当前播放头
- 客户端播放头 = `positionMs + max(0, (deviceNow + clockOffset) - anchorServerMs)`（仅 `isPlaying`）
- 时钟：`np_ping` / `np_pong` 采样，**只保留 RTT 最小**的 `clockOffset`
- 服务端每 **10 秒** 通过 `alarm()` 主动广播 `room_state_updated`（带完整锚点）

## 消息一览

控制（仅 CONTROLLER）：`PLAY` `PAUSE` `SEEK` `SET_TRACK` `SET_QUEUE` `PLAYBACK_MODE` `TRACK_FINISHED` `HEARTBEAT`
请求（LISTENER）：`REQUEST_PLAY` `REQUEST_PAUSE` `REQUEST_SEEK` `REQUEST_SET_TRACK`
请求必须带 `requestTrackStableKey`，服务端校验「房间策略 + 房主在线 + 与当前曲目一致」后才转成控制事件。

心跳：`ctx.setWebSocketAutoResponse(WebSocketRequestResponsePair('ping', 'pong'))`，不唤醒 DO。
重连：用 `memberId + memberSecret` 恢复角色，**不触发暂停**。

## 音频与隐私

- 服务端只存 `{ source, id, name, singer, durationMs }`，不存直链
- 直链候选最多三条、只在内存里、切歌/散会即清，**不写 ctx.storage**

## 测试

```bash
node --import ./test/hook.mjs test/run.mjs   # 17 项：锚点/权限/请求校验/重连/队列推进/alarm
```
