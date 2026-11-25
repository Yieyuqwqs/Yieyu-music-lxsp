# 架构交接 · 一起听（P2P / MQTT）

> 目标读者：接手「一起听」功能的人。只描述**当前代码实际行为**，不描述设想。

---

## 一、总体结构

```
┌───────────── 设备 A（控制端 / host）─────────────┐        ┌───────── 设备 B（成员 / guest）─────────┐
│ RN 播放器 (react-native-track-player / ExoPlayer) │        │ RN 播放器                                │
│        ▲                                          │        │        ▲                                 │
│        │ setMusicUrl（App 原生解析管线）          │        │        │ setMusicUrl（本机解析）         │
│   PlayerAdapter                                   │        │   PlayerAdapter                          │
│        ▲                                          │        │        ▲                                 │
│   RoomSession（状态机，唯一对齐入口）             │        │   RoomSession（version 守卫）            │
│        ▲                                          │        │        ▲                                 │
│   ListenTogetherService（单例 / 房间生命周期）    │        │   ListenTogetherService                  │
│        ▲                                          │        │        ▲                                 │
│   P2PRoom（状态压缩 + 发布）                      │        │   P2PRoom                                │
└────────┼──────────────────────────────────────────┘        └────────┼─────────────────────────────────┘
         │  MQTT over WebSocket（公共 broker，QoS1）                   │
         └──────────────►  topic 与房间 ID 绑定  ◄────────────────────┘
                          UDP 直连通道（STUN 打洞，LXP1 包头）为可选加速
```

**关键设计（也是本轮修出来的）**

1. **每台设备各自解析直链**。房间只广播「播放什么、从哪里开始、是否在播」，**绝不发送直链**。
   历史教训：跨设备分发直链曾导致成员端 100% 收到过期链接（403/410）。
2. **状态只有一个写入方**：成员端只由 `RoomSession.applyState` 对齐播放器，且带 `version` 幂等守卫。
3. **时长只由原生事件驱动**：`PlaybackState=Ready` → `refreshDuration()` → `setMaxplayTime`。没有计时器兜底。

---

## 二、消息与状态

### 2.1 房间状态（`RoomState`）

| 字段 | 说明 |
|---|---|
| `version` | 单调递增。**成员端只在 version 变化时应用一次**，重复广播不会重复动作 |
| `playback` | `{ positionMs, anchorServerMs, isPlaying, trackStableKey }`，锚点模型 |
| `queue` / `currentIndex` | 共享队列（最多 200 首） |
| `members` | 成员列表（角色 / 在线 / 心跳） |
| `settings` | 允许成员点歌、是否要求房主在线、人数上限 |

### 2.2 播放头计算

```
playheadMs = isPlaying ? positionMs + max(0, serverNow - anchorServerMs) : positionMs
```
`anchorServerMs` 用服务端时钟；本机与服务器做时钟同步（`mergePong` 只保留 RTT 最小的样本）。
**位置对齐只发生在换歌起播那一刻**，运行中不做 drift seek、不做变速。

### 2.3 控制消息（控制端 → 房间）

`PLAY` / `PAUSE` / `SEEK` / `SET_TRACK` / `SET_QUEUE` / `QUEUE_ADD` / `QUEUE_REMOVE` / `PLAYBACK_MODE`
每一项都会 bump `version` 并广播新状态。

### 2.4 成员请求

成员端受 `isSendingAllowed()` 限制：**成员不能直接发控制事件**，只能走 `request(...)` 请求房主。
这条守卫有专门测试（`tests/lxsp/room-session.test.mjs`：成员端一条控制事件都不许发）。

---

## 三、换歌的完整调用链（当前唯一路径）

```
房主：队列点击 / 播放器下一首
  └─ ListenTogetherService.switchToTrack(track)
       ├─ 重入闸门：同曲 2 秒内只切一次
       ├─ 在线曲目：toNewMusicInfo(types:{}, _types:{}) → setPlayMusicInfo → setMusicUrl
       ├─ 本地文件：房间直链 → probeMediaUrl → 通过才播；失败记入死链缓存（10 分钟）
       └─ 全部失败：按 stableKey 在本地列表/搜索里找同名同歌手

成员：收到 room_state_updated（version 变化）
  └─ RoomSession.applyState(state)
       ├─ 控制端：直接返回（以本地为准）
       ├─ 同 version：直接返回
       ├─ trackStableKey 变化 → track_changed → switchToTrack
       └─ isPlaying 变化 → play / pause 一次
```

---

## 四、传输模式

| 模式 | 说明 | 现状 |
|---|---|---|
| `p2p` | 公共 MQTT broker（`broker.emqx.io:8084` 主 / `broker-cn.emqx.io:8084` 备），双发 | 默认，可用 |
| 直连 | STUN 打洞 + UDP（`LXP1` 包头、去重窗口、NAT 保活） | 代码在位，随模式启用 |
| 自建服务 | `cloud/listening-room/`（Cloudflare Worker + Durable Object） | 代码在位；`*.workers.dev` 在用户网络不可达 |

---

## 五、不变量（改动时必须保持）

1. 直链**不出设备**（没有 `URL_SHARE`、没有队列直链预热）
2. `switchToTrack` 是**唯一**换歌入口
3. `refreshDuration` 是 `duration` 写入 UI 的**唯一**事件驱动入口
4. 成员端不得发控制事件
5. 同一 `version` 的重复广播不得产生任何播放器动作
