# 已知限制（TODO 的正式去处）

> 出处：宪法第七条要求「任何 TODO / 临时开关必须在同一次交付内完成或删除」。
> 2026-11-27 清理时，源码里 8 处历史 TODO 只有在「真的没做」时才保留价值 ——
> 于是把它们从注释搬到这里，逐条写清现状、影响、为什么现在不做。源码里不再留 TODO。

## 1. 一起听 · 同步模块出错只断连，不回报状态
- 位置：`src/plugins/sync/client/modules/{dislike,list}/localEvent.ts`
- 现状：远端队列同步失败 → `moduleReadys[x] = false` + `socket.close(failed)`，只打日志。
- 影响：用户只看到「同步断了」，不知道是哪一类数据、为什么。
- 为什么不做：需要一个统一的 sync 错误事件通道（现在没有），属于功能设计范畴，不在本轮缺陷修复范围。

## 2. ~~启动自动播放设置未接入~~（已修复）
- 位置：`src/plugins/player/playList.ts`（restorePlayInfo 分支）
- 现状：已按设置决定 play/pause，不再靠启动流程里的定时器兜回来。
- 回归：`tests/lxsp/build-config.test.mjs`（「恢复播放：启动自动播放必须说了算」）

## 3. 本地歌曲换源成功后不缓存直链
- 位置：`src/core/music/local.ts`
- 现状：换源拿到直链后 `saveMusicUrl(目标源)`，本地条目本身不落直链。
- 影响：同一首本地歌曲每次播放都要重新解析一次（多一次网络往返）。

## 4. 下载条目的封面/直链不回写
- 位置：`src/core/music/download.ts`
- 现状：在线解析到的 picUrl/url 不回写进下载记录。
- 影响：下载列表里部分封面需要每次重新拉取。

## 5. 歌单同步的「更新时间」没有推到 UI
- 位置：`src/core/syncSourceList.ts`
- 现状：`setListUpdateTime` 落库了，界面用的格式化时间没有更新入口。
- 影响：同步完成后列表卡片上的时间不会立刻变化（重进页面才对）。

## 6. 资源缓存页的「清列表缓存」未接入
- 位置：`src/screens/Home/Views/Setting/settings/Other/ResourceCache.tsx`
- 现状：只有「查看大小」，没有清理入口。
- 影响：用户想清缓存只能清 App 数据。

## 7. 默认列表信息未持久化
- 位置：`src/types/list.d.ts`
- 现状：`MyTempListInfo.meta` 只在内存里，重启丢失。
- 影响：临时列表的元信息（如来源）重启后消失。

---

## 附：本轮已修掉、不再属于限制的项

| 曾经的 TODO/缺陷 | 现在 |
|---|---|
| `music/utils.ts` 两处 `as any` 取歌词 promise | 改为具名接口 `LegacyLyricRequest`，类型可查 |
| 存储批量写入不镜像、删除不清缓存 | 见 `tests/lxsp/storage.test.mjs`（5 条不变量） |
| 端点探测等所有探测 settle / 端点串行 / 旧接口族串行 | 见 `tests/lxsp/source-engine.test.mjs`（3 条延迟断言） |
| `canceleFn` 空实现 | 见「取消：canceleFn 必须真的掐断解析」 |
