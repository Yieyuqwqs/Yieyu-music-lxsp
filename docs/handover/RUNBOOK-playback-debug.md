# 排查手册 · 播放故障（无 adb 环境）

> 适用：设备上没有 root、没有 Shizuku、拿不到 logcat，只能看 App 内日志与共享存储。

---

## 一、能拿到的三条证据通道

| 通道 | 位置 | 内容 |
|---|---|---|
| App 内日志 | 设置 → 其他 → 查看日志 | `[playback] …`、`[autocheck] …`、错误堆栈 |
| 共享存储 | `/sdcard/lxsp-autocheck.json` | 每首歌 Ready 后 3 秒采样：`durationMs / positionMs / state / ok` |
| 面板状态行 | 设置 → 其他 → 一起听 | `lastEvent` / `lastError`（最后一次动作与原因） |

`[playback]` 行的格式：

```
[playback] state=8 pos=120430ms dur=239000ms     ← pos 非 0：正常换歌
[playback] state=8 pos=0ms      dur=239000ms     ← pos 为 0：播放位置被重置（真 bug）
[playback] probe ok=false http=403 bytes=146 type=text/html url=…   ← 房间直链被对端拒绝
ERROR [playback] error=Response code: 403 {"active":…,"duration":…,"position":…}
```

---

## 二、症状 → 证据 → 定位

| 症状 | 先看 | 判定 | 下一步 |
|---|---|---|---|
| 主界面 `00:00/00:00` | `[autocheck]` 的 `duration` | `≈200-300ms` = 伪时长（媒体不可播）；`几万 ms` = 时长正常 | 伪时长 → 走第三节（验链接）；真时长但 UI 不更新 → 查 `refreshDuration` 是否被调用 |
| 每秒被拽回 | `[playback] state` 频率 | 每秒一组 `3/6/8/0` = 有人在反复切歌 | 面板 `lastEvent` 看「切歌请求：…（执行/重复，已忽略）」 |
| 播到一半跳回开头 | `state=8 pos=…ms` | `pos` 非 0 = 卡顿/缓冲；`pos=0` 且时间点固定 = 被重置 | 查 `handlePlayMusic` 的 `seek(time)` 入参 |
| 无声但显示在播 | `[autocheck] ok=false` | `state=unavailable` = RNTP 版本没有该方法，不代表没播 | 看 `probeMediaUrl` 结果与 `duration` |
| 成员端一操作就回落 | 面板 `lastError` | 出现「请求被拒」= 成员权限守卫生效（设计如此） | 让房主操作，或开「允许成员点歌」 |

---

## 三、验链接（决定是 App 还是网关的问题）

```bash
# 网关取链接
curl -s -H "X-Api-Key: <KEY>" "http://127.0.0.1:1101/api/v0/url/kw/<songId>/320k"
# 验字节
curl -s -H "Range: bytes=0-1023" "<链接>" -o /tmp/a.bin -w "%{http_code} %{size_download} %{content_type}\n"
xxd /tmp/a.bin | head -3   # 期望 ff fb / 49 44 33 / 66 4c 61 43
```

- `200` + `text/html`、`403`、`410`、`0 字节` → **网关问题**，不要在 App 层继续加壳
- `206` + `audio/*` + 正确音频头 → 链接没问题，回到 App 侧

---

## 四、常见误判（血泪）

1. **`state=3/6/8/0` 不等于 bug**：换歌时就会出现这一段。判据是「频率」与「`pos` 是否归零」。
2. **`duration=205ms` 是伪时长**：ExoPlayer 对加载失败的流会报几百毫秒。判据必须 `> 5000ms`。
3. **`probe ok=false` 不代表 App 坏了**：房间直链本来就是对端签名的，跨设备几乎必死——现在已不再用它播放。
4. **`getPlaybackState is not a function`**：本项目的 RNTP 版本没有该 API，遥测已改为可选调用，不必修。
