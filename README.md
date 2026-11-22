<div align="center">

# Yieyu Music

**夜雨 · 沉浸式音乐播放器（Android）**

[![Release](https://img.shields.io/github/v/release/Yieyuqwqs/Yieyu-music?label=release&color=ff4d6d)](https://github.com/Yieyuqwqs/Yieyu-music/releases/latest)
[![Build](https://img.shields.io/badge/build-GitHub%20Actions-2f81f7)](https://github.com/Yieyuqwqs/Yieyu-music/actions)
[![Platform](https://img.shields.io/badge/platform-Android%207.0%2B-3ddc84)](#-安装)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

基于 [洛雪音乐](https://github.com/lyswhut/lx-music-mobile) 深度定制 · 全界面重做 · 音效全链路重写

当前版本：**v1.9-Aurora** · 包名 `com.yieyu.music`

</div>

---

## ✨ 为这个项目定制的功能

### 🎨 全新纯原创的现代化沉浸式 UI

- **完全重写的视觉层**：与上游洛雪完全不同的设计语言，纯原创、非套壳换皮。
- **黑胶唱片**：播放页以旋转黑胶为核心视觉，专辑封面化身唱片，针臂、纹理、光泽全部手绘级还原。
- **胶囊组件**：按钮、标签、进度、切换器统一为**胶囊（Capsule）**形态，圆润、轻盈、动效跟手。
- **动态主题色**：从当前封面取色 → 实时计算主题色 → **整界面渐变、光晕、频谱同步变色**，每首歌都有专属氛围。

### 🎚️ 专业级音频处理链

- **10 段均衡器（EQ）**：SUB / BASS / LOW MID / MID / HIGH MID / PRESENCE / TREBLE 等 10 个频段独立增益，支持预设一键切换与自定义保存。
- **卷积混响（Convolution Reverb）**：基于真实脉冲响应的空间建模，不是简单的 Delay 叠加，人声通透、尾音自然。
- **ViPER4Android 风格空间环绕**：**宽场（Wide）**、**深度（Depth）**、**旋转（Rotate）** 三档可选，模拟外放/耳机两种声场，带软限幅与 DC 阻断保护，长时间聆听不刺耳。
- 音效链全部**本地实时运算**，不改动原始音频文件。

### 🌈 播放页全屏半透明频谱可视化

- 播放页背景铺满**半透明动态音频频谱**，随低/中/高频实时起伏。
- 动态曲线经过**柔和化处理**（快升慢落 + 响度平滑），不闪眼、不抽搐。
- 与「动态主题色」联动：频谱颜色跟随封面主色渐变。

### 🧩 洛雪音源解析 · JS 沙盒无缝兼容

- 完整保留上游 **LX Music 自定义音源机制**：`.js` 音源脚本在 **QuickJS 沙盒**中运行，`lx.on('request')`、`lx.request` 等 API 全兼容。
- 已有洛雪音源脚本**无需修改**，导入即用。
- 文件关联已注册：双击 `.js` / `.lxmc`（歌单）即可导入本应用。

### ⚙️ 核心底层全 Kotlin 原生接管（ExoPlayer）

- 播放内核由 **Kotlin + ExoPlayer（Media3）** 原生接管，不走 JS 桥接播放，**切歌零延迟、后台稳定、断点续播**。
- 原生模块覆盖：下载服务（前台 Service）、歌词桌面显示、音效处理、文件读写、缓存清理、屏幕常亮等。
- 通知栏 / 锁屏 / 蓝牙 / 耳机线控 全原生联动。

---

## 📲 安装

1. 打开 [**最新 Release**](https://github.com/Yieyuqwqs/Yieyu-music/releases/latest)。
2. 按 CPU 架构选包：
   - `arm64-v8a` — **绝大多数手机选这个**
   - `armeabi-v7a` — 老机型
   - `x86_64` / `x86` — 模拟器
   - `universal` — 不确定就选它（体积最大）
3. 安装即可，桌面名称为 **Yieyu Music**。

> ⚠️ **包名变更提醒**：本版包名已改为 `com.yieyu.music`，从旧版（`cn.toside.music.mobile`）升级需要**先卸载旧版**。此后所有版本使用固定签名，**版本升级可直接覆盖安装，无需卸载**。

## 🔑 授权（VIP 卡密）

- 软件采用**离线卡密**授权：激活后**不联网也能用**，本机校验。
- 卡密格式：**16 位短卡密**，形如 `YIEYU-XXXX-XXXXX`，绑定**本机设备码**，一码一机。
- 设备码在「授权页」点击即可复制，发给管理员换卡密。
- 支持有效期：**1 天 / 7 天 / 30 天 / 365 天 / 永久 / 自定义天数**。
- 未激活时仅显示全屏授权页；到期、时间回拨异常会立即切回授权页。

## 🛠️ 自行构建

```bash
# 环境：Node.js 18+、JDK 17、Android SDK (compileSdk 34)
git clone https://github.com/Yieyuqwqs/Yieyu-music.git
cd Yieyu-music
npm install --legacy-peer-deps

# 客户端（com.yieyu.music）
cd android && ./gradlew assembleRelease

# 管理端（com.yieyu.music.admin，仅自用）
./gradlew assembleRelease -PyieyuAdmin=1
```

CI 侧每次打包都会用 **固定证书** 签名，并用 `scripts/verify-apk-signature.js` 直接读取 APK 签名块强校验指纹：**指纹不符直接构建失败**，因此 Releases 里的包永远可以互相覆盖升级。

证书指纹：`A64D1DB9 7260115A 99C0FE46 6B374317 61E09BCE BE1D1BDECD85A847C5B4E994`

## 📁 目录速览

| 路径 | 说明 |
| --- | --- |
| `src/` | 界面、状态、播放逻辑（TypeScript / React Native） |
| `android/` | Kotlin 原生模块、ExoPlayer、下载/歌词服务 |
| `src/utils/rsa.js` | 纯 JS RSA-2048（旧版长卡密兼容） |
| `src/utils/hmacSha256.js` | 纯 JS HMAC-SHA256（16 位短卡密校验） |
| `scripts/` | 变体切换、签名校验、密钥生成等构建脚本 |

## 🙏 致谢与声明

- 感谢 [**lx-music-mobile**](https://github.com/lyswhut/lx-music-mobile) 与 **洛雪音乐** 的开源工作，本项目的音源解析与播放能力建立在其之上。
- 本项目仅用于**个人学习与技术研究**，所有音乐内容来自用户自行添加的音源，软件本身**不提供、不存储任何音频资源**。
- 请支持正版音乐。因使用本软件产生的任何版权或法律问题，由使用者自行承担。

<div align="center">

**Made with ❤️ by Yieyu** · v1.9-Aurora

</div>
