# 授权体系（设备码 + 强指纹）· v1

> 一句话：**不再发卡密**。管理员把用户设备码填进云端白名单，用户在手机上录指纹；
> 之后每次打开、每次锁屏回来都要按一次指纹。换手机 = 管理员换白名单条目 **或** 老机器导出迁移码。

## 0. 为什么把卡密废了

旧方案（16 位 `YIEYU-XXXX-XXXXX`）是**对称**校验：密钥 `CARD_SECRET_HEX` 必须同时存在于
客户端与管理端，而本仓库是公开仓库 → 密钥等于公开，任何人都能自己发卡。
新方案把「谁能用」搬到两条独立链路上：

| 链路 | 归谁管 | 落点 |
| --- | --- | --- |
| 认设备 | 管理员（云端白名单） | `Yieyu-music-lxsp/whitelist.json`（公开仓库，只有 HMAC 后的条目键） |
| 认人 | 用户手机（系统指纹） | Android Keystore 加密令牌，锁屏即熔断 |

## 1. 设备码

```
seed      = "and|" + 包名 + "|" + ANDROID_ID + "|" + Build.MANUFACTURER + "|" + Build.MODEL + "|" + Build.DEVICE + "|" + Build.BOARD
设备码    = format(sha256("yieyu-devcode|v3|" + seed)[0..16])         # XXXX-XXXX-XXXX-XXXX
```

* 只用**重装/清数据都不变**的字段（`ANDROID_ID` 在 Android 8+ 按「应用签名 + 设备 + 用户」固定）。
* 换手机才变号；同型号不同机不会撞号（ANDROID_ID 不同）。
* 实现在 `android/authz/src/main/cpp/authz_core.cpp`，Java 只负责拼 seed。

## 2. 条目键（白名单/黑名单里的那一串 64 位十六进制）

```
条目键 = hex(hmac_sha256(AUTHZ_SECRET, "yieyu-authz|v1|dev=" + normalize(设备码)))
```

* `AUTHZ_SECRET` 32 字节，**不进仓库**：CI 用 Secret `AUTHZ_SECRET_B64` 注入
  （`scripts/write-authz-secret.js` → `android/authz/src/main/cpp/authz_secret.h`，XOR 掩码存放）。
* 客户端与管理端必须是同一把，否则管理端写进白名单的条目客户端永远匹配不上。

`whitelist.json`：

```json
{
  "version": 1,
  "updatedAt": "2026-11-27T00:00:00.000Z",
  "devices": [{ "k": "<64 hex>", "exp": "2027-01-27T00:00:00.000Z", "at": "2026-11-27T00:00:00.000Z" }]
}
```

`exp: null` = 永久。`Yieyu-music-lxsp/blacklist.json` 形状不变（`keys` 里放的也是条目键），`keys` 里放的也是条目键。

## 3. 本机令牌（Keystore）

绑定成功后落盘的是这段 JSON 的**密文**（AES-256-GCM，密钥在 Android Keystore，
`setUserAuthenticationRequired(true)` + `setInvalidatedByBiometricEnrollment(true)`）：

```json
{ "v": 1, "k": "<条目键>", "exp": null, "code": "<设备码>", "bound": "<ISO>", "via": "whitelist|migration|offline" }
```

* 读/写都必须过 `BiometricPrompt`（强生物识别，不给 PIN 兜底）。
* 解出来的 `k` 必须等于本机当前算出的条目键，否则视为「拷来的令牌」直接作废。
* 用户新增/删除系统指纹 → 密钥作废（`KeyPermanentlyInvalidatedException`）→ 必须重新绑定。
* 锁屏（`ACTION_SCREEN_OFF`）→ Java 抛事件 → JS 清内存令牌 → 界面掉回授权页。

## 4. 迁移码（换机）

老设备在「授权中心 → 导出迁移码」生成（前提：已通过指纹）。格式 `YMG1-<base32>`，负载 23 字节：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 1 | 版本 = 1 |
| 1 | 2 | 到期日（0 = 永久），编码同旧卡密：`2020-01-01` 起的天数 + 1 |
| 3 | 4 | 签发时间（Unix 秒，大端） |
| 7 | 4 | 随机 nonce |
| 11 | 4 | 老设备标签 = `sha256("yieyu-migrate|src|" + 设备码)[0..4]` |
| 15 | 8 | `hmac_sha256(AUTHZ_SECRET, "yieyu-migrate|v1|" + hex(前 15 字节))[0..8]` |

* **24 小时有效**（含 5 分钟时钟容差），本机记录已用 nonce，同一串不能在这台机器上重复用。
* 只证明「这份授权是老设备主动交出来的」，不绑定新设备；新设备导入后立刻与**自己的**设备码 + Keystore 重新绑定。
* 已知边界：完全离线的第三方无法被彻底阻止（对称方案通病），管理端删旧条目后老设备联网即失效。

## 5. 离线授权串（没网救急 / 管理员直接给）

管理端「生成离线授权串」（需要 CI 注入的 RSA 私钥 `LICENSE_KEYPAIR_B64`）：

```
payload = "YIEYU-AUTH|v4|dev=<设备码>|exp=<YYYYMMDD|20991231>"
串      = "YEYA.<expToken>.<hex(RSA-2048 PKCS#1 v1.5 SHA-256 签名)>"
```

客户端用内置公钥 `src/config/licenseKey.ts` 验签；管理端签完会**自己先验一遍**，
公私钥不匹配直接报「私钥没注入」。串里的设备码写死，贴到别的手机无效。

## 6. 状态机（`src/core/authz/protocol.ts` 的 `evaluate`）

| 状态 | 含义 | 授权页按钮 |
| --- | --- | --- |
| `boot` | 初始化中 | — |
| `none` | 白名单里没有本机 | 刷新授权状态 |
| `ready` | 白名单有，本机未绑定 | 绑定本机指纹 |
| `locked` | 本机已绑定，需解锁 | 按指纹进入 |
| `active` | 已解锁 | （进主界面） |
| `expired` | 到期 | 刷新（管理员续期后自动 ready） |
| `banned` | 条目在黑名单 | 联系管理员 |
| `tampered` | 系统时间被调回 | 校准时间 |
| `no_biometric` | 没指纹硬件/没录入 | 重新检查指纹 |
| `error` | 授权核自检失败 | 更新 App |

联网时：白名单把本机删了 → 令牌作废（只在**新鲜拉取**时生效，断网不会误伤）；
黑名单命中 → 立刻锁死并本地留痕（断网也拦）。

## 7. 运维清单

1. GitHub Secrets 增加 `AUTHZ_SECRET_B64`（客户端与管理端共用）：
   `node scripts/write-authz-secret.js --gen` 生成，只显示一次。
2. 老用户手上 16 位卡密**全部作废**，让他们发新设备码。
3. 名单仓库必须是**公开**仓库（`src/config/authz.ts` 的 `AUTHZ_REPO`，默认 `Yieyu-music-lxsp`）；
   私有仓库（如老的 `Yieyu-music`）匿名拉不到，客户端会一直「未授权」。
4. 开通：管理端填设备码 + 时长 → 写 `whitelist.json` → 用户在客户端点「刷新授权状态」→ 自动弹指纹。
5. 换机：管理端「移除该设备」+「开通」新设备码；或用户老机器导出迁移码给新机器粘贴。
6. 封禁：管理端「封禁该设备」（写 `blacklist.json`）。客户端联网即锁死。
7. 反查：`devices[].k` 是 HMAC 值，公开文件里看不到设备码明文；要核对某台机器就在管理端重算条目键比对。

## 8. 已知限制（诚实清单）

* 客户端 APK 里必然带 `AUTHZ_SECRET`（否则无法离线校验），提取 `.so` 后可以伪造条目——
  所以白名单**同时**是管理端的唯一真相：只要能连上云端，就以云端为准。
* 想更硬的话，下一步是把设备身份换成「应用签名 + 硬件 keystore 证明」的线上挑战应答（需要服务器）。
* `ANDROID_ID` 在极少数设备上可能缺失 → 退回本机随机 seed（此时清数据会变号，界面会提示）。
