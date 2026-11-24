# 第三条 · 状态只有一个来源

- **房间号**：只来自本地 create/join 入参；对端消息里的房间号只用于校验
- **房间状态**：只有房主能写；guest 只读，且只接受 `version` 更大的状态
- **通道状态**：`P2PRoom.setTransport()` 是唯一写入口，UI 只显示 `transport`
- **切房/切模式/离开**：必须走同步 `teardownSync()`，再建新会话

## 判定
`tests/lxsp/audit.test.mjs` 中断言：
- `RoomStatus` 不再有 `direct` 字段，只保留 `transport`
- `transport` 赋值 ≤ 2 处
- roomId 不被对端消息改写
