# 一起听（Listening Together）

两个人（或更多人）同时听同一首歌、进度对齐。**音频永远不经过任何中继**：每个客户端自己向后端要直链，服务端/房主只同步「放什么、放到哪」。

## 三种后端模式（客户端同一套代码，按「服务器地址」自动切换）

| 地址写法 | 模式 | 需要什么 | 适合 |
| --- | --- | --- | --- |
| `p2p` | **免部署**：公共 MQTT broker 中转，房主手机就是权威端 | 什么都不需要 | 跨网络、异地朋友（推荐） |
| `http://127.0.0.1:1103` | 本机/局域网：`cloud/listening-room/local-server.mjs` | 一台跑 Node 的机器（可用 Termux） | 同一台手机 / 同一 WiFi |
| `https://xxx` | Cloudflare Workers + Durable Object | CF 账号（`deploy.mjs` 一键部署） | 有公网地址且能连通 |

`p2p` 还可以指定 broker：`p2p:wss://broker.hivemq.com:8884/mqtt`（默认 `wss://broker.emqx.io:8084/mqtt`）。

## 同步模型：只有锚点

```jsonc
"playback": { "positionMs": 30000, "anchorServerMs": 1700000000000, "isPlaying": true, "trackStableKey": "kw:42" }
```

- **PLAY / SEEK / SET_TRACK**：`anchorServerMs = now + 400`（留网络提前量）
- **PAUSE**：`anchorServerMs = now`，`positionMs` 定格在当前播放头
- 播放头 = `positionMs + max(0, serverNow - anchorServerMs)`（仅 `isPlaying`）
- 时钟：`np_ping` / `np_pong` 采样，**只保留 RTT 最小**的偏移

## 消息

控制（房主）：`PLAY` `PAUSE` `SEEK` `SET_TRACK` `SET_QUEUE` `PLAYBACK_MODE` `TRACK_FINISHED` `HEARTBEAT`
请求（成员）：`REQUEST_PLAY` `REQUEST_PAUSE` `REQUEST_SEEK` `REQUEST_SET_TRACK`，必须带 `requestTrackStableKey`
广播：`room_state_updated`（完整锚点 + 成员表），房主每 10 秒补发一次；成员 25 秒收不到就判定房间已结束

## 换歌怎么过去（踩过的坑）

单靠 `source:id` 不行：**同一个 id 在对方曲库里不一定存在**。现在的顺序：

1. **房主直接带直链**：`TrackPlayer.getActiveTrack().url` 一起发出去，成员端 `setResource(info, url, seek)` 直接放
2. 没有直链时，用 `source + songmid` 还原成在线曲目，让对方播放器自己解析
3. 再不行退回：当前列表匹配 → 内置搜索（歌名 + 歌手）
4. 都失败才提示「本机没找到」

注意：直链是**有时效的签名 URL**，过期后房主重点一次「同步当前歌曲」即可。

## 文件

- 客户端：`src/core/listen-together/{client,mqtt,p2p-room,room,service,playhead,track-map,protocol}.ts`
- 界面：`src/screens/Home/Views/Setting/settings/Other/ListenTogether.tsx`
- 播放器钩子：`src/core/player/hooks.ts`（`onPlay/onPause/onSeek/onTrackChange`）
- 服务端：`cloud/listening-room/`（`room-do.ts` / `local-server.mjs` / `deploy.mjs` / `add-domain.mjs`）
- 测试：`tests/lxsp/{listen-together,room-session,track-map}.test.mjs`、`cloud/listening-room/test/*`

## 已知限制

- `p2p` 走公共 broker：房号=口令，消息明文（不含账号/密钥）；broker 抽风就换一个
- 房主退出=房间结束（没有服务端持久化）
- 成员端只跟随播放/暂停/进度/换歌；「申请播放」要房主客户端同意（p2p 模式由房主 App 校验）
