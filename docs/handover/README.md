# 交接文档索引

| 文档 | 看它就够了你需要做什么 |
|---|---|
| [HANDOVER-2026-11-25.md](./HANDOVER-2026-11-25.md) | **总览**：修好了什么（8 项，带提交）、没修好什么（3 项）、下一步先验网关、陷阱清单 |
| [ARCH-listen-together.md](./ARCH-listen-together.md) | **架构**：节点图、状态模型、锚点播放头、换歌唯一调用链、5 条不变量 |
| [RUNBOOK-playback-debug.md](./RUNBOOK-playback-debug.md) | **排查**：三条证据通道、症状→证据→定位表、日志字段含义、常见误判 |
| [RUNBOOK-gateway-verify.md](./RUNBOOK-gateway-verify.md) | **验网关**：必查四步、失败样本含义、三个怀疑点 |
| [RUNBOOK-release.md](./RUNBOOK-release.md) | **发布**：无 git 如何推送、如何触发构建、如何取日志、构建前必须全绿 |
| [TESTING-and-CONSTITUTION.md](./TESTING-and-CONSTITUTION.md) | **测试与合规**：36 项测试分层、宪法 1–14 条对应校验、第十四条授权流程、交付格式 |
| [POSTMORTEM-2026-11-25.md](./POSTMORTEM-2026-11-25.md) | **复盘**：时间线、我犯的 4 个错误、做对的 3 件事、30 分钟重来版 |
| [ENVIRONMENT-setup.md](./ENVIRONMENT-setup.md) | **环境**：本机没有 git/gh/adb 的事实、必需路径、起网关、跑测试 |
| [PROTOCOL-reference.md](./PROTOCOL-reference.md) | **协议**：房间消息表、状态压缩格式、LXSP v2 端点与错误码、直链生命周期 |
| [FAQ.md](./FAQ.md) | **FAQ**：10 个高频问题（00:00、补丁、成员权限、CI 红、已知未解） |
| latest.md | 自动生成（`node tools/handover.mjs`），记录最近一次命令的真实输出；**手改会被覆盖** |

## 最短上手路径

```bash
# 1. 当前是否健康
cd ~/lxdl/lx-music-mobile-master && sh tools/self-verify.sh        # 结尾必须 SELF-VERIFY: PASS

# 2. 播放有问题先验链接（不要先改 App）
cd ~/lx-server && node server.js &
curl -s -H "X-Api-Key: <KEY>" "http://127.0.0.1:1101/api/v0/url/kw/62355680/320k"
curl -s -H "Range: bytes=0-1023" "<直链>" -o /tmp/a.bin -w "%{http_code} %{size_download} %{content_type}\n"
xxd /tmp/a.bin | head -3     # 206 + audio/* + ff fb / ID3 / fLaC

# 3. 设备侧唯一可读证据
cat /sdcard/lxsp-autocheck.json    # duration 若为 200-300ms 就是伪时长（媒体不可播）
```

## 三条红线

1. **直链不出设备**（成员各自解析）——恢复跨设备分发直链会立刻复发 403/410
2. **不加计时器兜底/对齐**——它是"秒跳"的根因
3. **不改审计脚本/CI/宪法**（第十四条），需要时先申请授权
