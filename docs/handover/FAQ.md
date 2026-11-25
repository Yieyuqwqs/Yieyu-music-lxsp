# FAQ · 接手人会问的问题

**Q1：界面 `00:00/00:00`，歌在放吗？**
先看 `/sdcard/lxsp-autocheck.json` 的 `duration`：`≈200-300ms` = 媒体不可播（伪时长）；`几万 ms` = 时长正确，问题在 UI 更新链路（查 `refreshDuration` 是否被 `Ready` 调到）。

**Q2：为什么删掉了"播放前校验"和"计时器重试"？**
因为它们是补丁：前者多一次请求且掩盖数据源问题，后者是"读早了就再试"的兜底。宪法第一条禁止补丁式开发；正确做法是修数据源（缓存 TTL / 不跨设备分发）。

**Q3：成员为什么不能切歌？**
设计如此：成员只有 `request(...)` 权限，`isSendingAllowed()` 硬性拦截，并有测试断言"成员端一条控制事件都不许发"。需要放开就开 `settings.allowListenerRequests`。

**Q4：`state=3/6/8/0` 是不是坏了？**
不一定。换歌时会出现这段序列。判据是**频率**（每秒一次 = 有人反复切歌）和 **`pos` 是否归零**（归零 = 位置被重置）。

**Q5：`*.workers.dev` 打不开怎么办？**
用户网络封锁该域名。代码在 `cloud/listening-room/`，可自绑域名或改用 `p2p` 模式（公共 MQTT broker，无需服务器）。

**Q6：CI 红了，能改 CI 配置吗？**
**不能**（第十四条）。CI 是 Node 18，`.ts` 不能直跑；`tools/self-verify.sh` 有版本门禁，<22.6 返回退出码 2「未测」。要动 CI 必须先取得授权。

**Q7：`[playback] probeError: undefined is not a function` 是什么？**
本项目 RNTP 版本没有 `getPlaybackState/getActiveTrack`，遥测已改为可选调用（`?.()`）。不是 bug。

**Q8：为什么仓库里有 `tests/lxsp/live-url.json` 会自己变红？**
里面是真实直链，几十分钟过期。用 `node tools/pipeline-check.mjs "<新直链>"` 刷新后再提交。

**Q9：改哪个文件可以动，哪个要申请？**
能动：`src/**`、`tools/device-sim.mjs`、`tools/pipeline-check.mjs`、`docs/handover/**`（非 latest.md）。
要申请：`AGENTS.md`、`docs/CONSTITUTION.md`、`docs/constitution/**`、`tools/self-verify.sh`、`tools/handover.mjs`、`tools/if-audit.mjs`、`tests/lxsp/audit.test.mjs`、`tests/lxsp/branch.test.mjs`、`tests/lxsp/modules.test.mjs`、`.github/workflows/**`。

**Q10：还有哪些已知未解？**
三条：① 设备端播放仍出现 `dur≈250ms`（疑似网关签发）；② "跳回"未拿到 `pos=0` 样本，未证实消失；③ Cloudflare Worker 自定义域名未绑（当前 `workers.dev` 不可达）。
