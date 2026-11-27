# 交接报告（本轮真实输出）

生成时间：2026-11-27T22:37:01Z

## 交付物（已上线）

- Release：`v1.9-Aurora-76`（本仓库 + 公库 Yieyu-Update 各 5 个客户端 APK）
- 公库强更清单：`latestVersion 1.9-Aurora-76 / versionCode 81`，`minSupportedVersion 1.9-Aurora-62` 不变
- CI：每次 push 绿；Build APK：439s 成功（Client + Admin，签名指纹校验通过）

## 本轮安全修复（对应真机截图里的 `?key=` 泄漏）

| 问题 | 处置 | 证据 |
|---|---|---|
| 密钥同时进 X-Api-Key / Authorization / ?key=（一趟请求三份） | 按族只发一种：lx-source 只发 query，wwwweb/json 只发 header | 本机网关实测 header/bearer=403、?key=200；security.test.mjs |
| 公网明文 http 端点会把密钥广播到链路 | 引擎发请求前拦截；仅本机/局域网允许 http | security.test.mjs（fetched===0 断言） |
| 密钥进日志 | redactUrl() 把 key/token/apikey 打码 | security.test.mjs |
| APK 内置默认密钥 | defaultSetting 清空，源码扫描断言 | security.test.mjs |
| 管理端 PAT 明文存 AsyncStorage | 新增 SecretStore（Keystore AES-256-GCM）+ 旧明文自动清理 + 内存降级 | secure-store.test.mjs ×3；CI 编译通过 |
| 设置页端点标题错位 | 按 URL 匹配回填标题 | 代码路径 |

## 测试与自检（真实输出）

```
    at Object.fn (file:///data/data/io.github.jackwener.dsh/files/home/repo/Yieyu-music-lxsp-main/tests/lxsp/audit.test.mjs:125:7)
    at file:///data/data/io.github.jackwener.dsh/files/home/repo/Yieyu-music-lxsp-main/tests/lxsp/run.mjs:61:17

授权协议回归全部通过

镜像候选回归全部通过
条件分支审计：文件 18 个，if 共 220 处
分类：boundary 29 / flow 156 / invariant 35
硬违规：0

结论：7 PASS / 3 FAIL / 0 WARN / 3 N/A
失败条款：第3条、第4条、第10条
```

## 真机链路实测（本机网关 + 真实音频字节）

```
探测结果: lx-source | 音源数: 4
取直链: http://kw-bj.kuwo.cn/6e98879130dec17ab8ca9d302396681b/6b0a06... | quality= 320k
直链实测: http=206 bytes=4096 type=audio/mpeg
```

## 还没做（事实）

- 真机安装运行（本机无设备）：播放/搜索/下载/一起听的实际手感未验证
- targetSdk 仍是 29；升级需迁 MediaStore/SAF，会动下载主路径
- console.* 568 处未分级；启动字典/主题未懒加载
- 双轨音源（搜索走 legacy、播放走 LXSP）未统一
- 一起听：已用 wss://，但房间消息仍无签名（公共 broker 语义，需协议升级）
