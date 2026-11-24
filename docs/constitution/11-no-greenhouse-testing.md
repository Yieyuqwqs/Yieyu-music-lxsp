# 第十一条 · 严禁温室测试，必须真机/真实链路闭环

## 1. 禁止纯 Mock 假象
任何涉及**网络请求、底层播放（ExoPlayer）、跨进程通信**的修复，
严禁仅凭 Mock/Stub 跑通测试就判定为"全绿"。

## 2. 真实数据注入
涉及解析、换源的代码，必须在测试中拉取**真实线上直链**（或真实抓包日志），
验证数据完整性与时效性（HTTP 200/206、能取到真实字节、非空非 HTML 错误页）。

## 3. 运行时证据（Logcat）
底层组件（ExoPlayer / 原生桥）的报错，必须提供真实运行时 Logcat 片段。
**拿不到日志时，必须在代码里强制 `reportError` 抛出真实异常，禁止静默吞掉。**

## 4. 判定标准
测试脚本里出现 `const mockPlayer = ...` / `const fakeUrl = ...` 之类，
必须由人类审批豁免并在文件内标注 `// human-exempt: <理由>`，否则视为弄虚作假。

## 当前已知缺口（诚实记录）
- 本机无 Shizuku，`adb logcat` 不可用 → 底层播放错误只能靠 App 内 `reportError` 通道 + 面板错误日志
- `tests/lxsp/room-session.test.mjs`、`listen-together.test.mjs` 使用 fake player/client → **需要人类豁免**或改为真实链路
- 真机打洞成功率、ExoPlayer 加载结果尚未闭环验证

## 判定
- 测试目录出现未豁免的 `mockPlayer` / `fakeUrl` / `const fakeXxx = ...` = 不合格
- 涉及网络/播放器/跨进程的修复，只给 mock 测试 = 不合格
- 真实链路测试连不上却仍判绿 = 不合格（必须 SKIP 并打印原因）
- 底层报错没有 Logcat、也没有 `reportError` = 不合格
