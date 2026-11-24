#!/usr/bin/env bash
# 一键真机验证（宪法第十一条工具）
#
# 你只需要：插上数据线、开 USB 调试，然后跑：
#   bash tools/one-click-deploy.sh
#
# 它做四件事：
#   1. adb install -r 最新 APK（从 Release 下的 APK 或你指定的路径）
#   2. adb shell am start 启动 App
#   3. adb logcat 抓取播放器遥测（App 内已埋点：MyExoPlayer 前缀 + 原有 YieyuCore）
#   4. 同时把 App 内部日志文件拉回本地（error.log，里面有 [playback] 采样）
set -eu

APK="${1:-}"
PKG="cn.toside.music.mobile"
ACTIVITY=".MainActivity"
OUT_DIR="${OUT_DIR:-./deploy-out}"
mkdir -p "$OUT_DIR"

echo "== 0/5 检查 adb =="
command -v adb >/dev/null 2>&1 || { echo "找不到 adb：请安装 Android Platform Tools 并加进 PATH"; exit 1; }
adb devices | sed -n '1,5p'

if [ -z "$APK" ]; then
  APK=$(find . -name "*.apk" -newer package.json 2>/dev/null | head -1 || true)
fi
[ -n "$APK" ] && [ -f "$APK" ] || { echo "没找到 APK，把路径作为第一个参数传进来：bash tools/one-click-deploy.sh /path/app.apk"; exit 1; }
echo "== 1/5 安装 $APK =="
adb install -r "$APK"

echo "== 2/5 启动 App =="
adb shell am force-stop "$PKG" || true
adb shell am start -n "$PKG/$ACTIVITY"

echo "== 3/5 抓取播放器日志（Ctrl+C 结束）=="
adb logcat -c
adb logcat -v time MyExoPlayer:V YieyuCore:V ReactNativeJS:V AndroidRuntime:E "*:S" | tee "$OUT_DIR/logcat.txt"

echo "== 4/5 拉取 App 内部日志（含 [playback] 采样）=="
adb shell run-as "$PKG" cat /data/data/$PKG/files/error.log > "$OUT_DIR/app-error.log" 2>/dev/null || \
  adb shell run-as "$PKG" cat /data/user/0/$PKG/files/error.log > "$OUT_DIR/app-error.log" 2>/dev/null || \
  echo "（debug 包才能用 run-as；release 包请看 App 内「设置 → 其他 → 查看日志」）"

echo "== 5/5 结果 =="
echo "  logcat       : $OUT_DIR/logcat.txt"
echo "  App 内部日志 : $OUT_DIR/app-error.log"
echo "  关注这几行    : [playback] state=… / sample duration=… / error=…"
