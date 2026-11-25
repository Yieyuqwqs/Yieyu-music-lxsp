# 运维手册 · 构建与发布（本机无 git / 无 gh）

---

## 一、环境事实

| 事实 | 影响 |
|---|---|
| 本机**没有 git 二进制** | 用 GitHub Contents API 增量推送（`~/.tmp_lxsp/push_delta.js`） |
| 本机**没有 gh CLI** | 用 API 触发 workflow、拉日志（见下） |
| 本机 **Node 24** | 测试依赖 `.ts` 直跑（≥22.6）；CI 是 Node 18，见「陷阱」 |
| 本机**没有 adb / Shizuku** | 无法 `pm install` / `logcat`；只能读 `/sdcard` 与 App 内日志 |
| 沙箱**硬拦截**读取 `.github/workflows/*.yml` | 不要尝试，会返回 `HARDLINE_BLOCKED` |

---

## 二、推送一个文件

```bash
cd ~ && printf "%s\n" path/to/file1 path/to/file2 > ~/.tmp_lxsp/delta.txt
COMMIT_MSG="fix(scope): 说明" node ~/.tmp_lxsp/push_delta.js
# 输出：每个文件 ok（更新）/ ok（新增）/ 跳过（内容一致）；最后打印远端 HEAD
```

---

## 三、触发构建

```bash
node -e '…POST /repos/Yieyuqwqs/Yieyu-music-lxsp/actions/workflows/build-apk.yml/dispatches {ref:"main"}'
# 然后 GET /actions/runs?per_page=1 取 run_number / id / status
```

产物（Release `v1.9-Aurora-62`，同名覆盖）：

```
Yieyu-music-mobile-v1.9-Aurora-62-arm64-v8a.apk
Yieyu-music-mobile-v1.9-Aurora-62-armeabi-v7a.apk
Yieyu-music-mobile-v1.9-Aurora-62-universal.apk
Yieyu-music-mobile-v1.9-Aurora-62-x86.apk
Yieyu-music-mobile-v1.9-Aurora-62-x86_64.apk
```

---

## 四、取构建日志

```bash
node ~/.tmp_lxsp/getlog3.js <runId>
# 写出 ~/.tmp_lxsp/ClientYieyuMusic.log
sed 's/\x1b\[[0-9;]*m//g' ~/.tmp_lxsp/ClientYieyuMusic.log | grep -nE "error|FAIL|SELF-VERIFY|exit code" | head
```

---

## 五、构建前必须全绿

```bash
cd ~/lxdl/lx-music-mobile-master && sh tools/self-verify.sh
# 1/4 分支审计  2/4 全量测试（36 项）  3/4 真机模拟闭环（5 项真实链路）  4/4 语法解析
# 结尾必须是 SELF-VERIFY: PASS
```

---

## 六、陷阱

1. **CI 是 Node 18**：`.ts` 无法直接 import。`tools/self-verify.sh` 有版本门禁（<22.6 → 退出码 2「未测」），**不要**把依赖 strip-types 的测试塞进 CI。
2. **`tests/lxsp/live-url.json` 会过期**：直链有效期几十分钟，过期会让真实链路用例变红。用 `tools/pipeline-check.mjs` 刷新后再提交。
3. **改 CI 配置 / 审计脚本 / 宪法 = 第十四条违规**：必须取得人类明确授权。
4. **提交信息要写清「性质」**：修根因 / 删补丁 / 结构重构，否则违反第九条（改动清单纪律）。
