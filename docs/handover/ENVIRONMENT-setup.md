# 环境搭建 · 从零到能改代码

---

## 一、这台机器的事实（先看，别撞墙）

| 项 | 值 | 影响 |
|---|---|---|
| Node | v24（有 `stripTypeScriptTypes`） | 测试可直接 import `.ts` |
| git | **没有** | 用 Contents API 脚本推送 |
| gh CLI | **没有** | 用 API 触发/查构建 |
| adb / Shizuku | **没有** | 不能 `pm install`、不能 `logcat` |
| 包管理器 | 无 npm/yarn 项目安装 | 依赖都在 `node_modules/`（若存在）或 `~/parsecheck/node_modules` |
| 沙箱 | 读 `.github/workflows/*.yml` 被硬拦截 | 不要试 |

---

## 二、必需的几个路径

```
~/lxdl/lx-music-mobile-master       仓库工作副本
~/lx-server/server.js               本地 LXSP 网关（node，端口 1101）
~/.tmp_lxsp/push_delta.js           增量推送（读 delta.txt + COMMIT_MSG）
~/.tmp_lxsp/getlog3.js             拉某次构建日志
~/tools/.gh_token                  GitHub PAT
~/tools/.cf_token / .cf_account    Cloudflare（可选）
/sdcard/lxsp-autocheck.json        App 自动核验输出（设备端）
```

---

## 三、起网关

```bash
cd ~/lx-server && node server.js &      # 监听 127.0.0.1:1101
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:1101/api/v0/url/kw/62355680/320k"   # 期望 401（鉴权生效）
```

Key 在 `src/config/defaultSetting.ts` 与网关两侧必须一致；**仓库是 public，注意不要泄露新 key**。

---

## 四、跑测试

```bash
cd ~/lxdl/lx-music-mobile-master
node --import ./tests/lxsp/hook.mjs tests/lxsp/run.mjs     # 36 项
sh tools/self-verify.sh                                    # 全套（审计+测试+真机模拟+解析）
```

`tests/lxsp/hook.mjs` 注册 `resolve-ts.mjs`：相对路径补扩展名、`@/` → `src/`、`react-native` → 桩、`.ts` 转译（Node≥22.6 内置，否则 Babel）。

---

## 五、推一个改动

```bash
printf "%s\n" src/xxx.ts > ~/.tmp_lxsp/delta.txt
COMMIT_MSG="fix(scope): 说明与性质" node ~/.tmp_lxsp/push_delta.js
```

---

## 六、设备侧（无法 adb 时的唯一路径）

```
App → 设置 → 其他 → 查看日志          # [playback] / [autocheck] / 错误堆栈
/sdcard/lxsp-autocheck.json           # 每首歌 Ready+3s 的 duration/position/state
设置 → 其他 → 一起听                   # 面板 lastEvent / lastError
```
