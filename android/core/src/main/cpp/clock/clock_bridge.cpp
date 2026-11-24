/**
 * 高精度时钟桥：给「一起听」做时间基准用。
 *
 * 为什么不在 JS 里用 Date.now()：
 *  - Date.now() 是墙钟，会被 NTP 校时、用户改时间、休眠唤醒扯动，差个几十毫秒就会让对齐抖一下
 *  - CLOCK_MONOTONIC 单调递增、不受校时影响，做「经过了多少毫秒」才是严谨的
 *
 * 暴露两个：
 *  nativeMonotonicMs() —— 单调毫秒（对齐计算用）
 *  nativeEpochMs()     —— 墙钟毫秒（和 UI/日志对得上，仅作展示）
 */
#include <jni.h>
#include <time.h>

namespace {

int64_t monotonic_ns() {
  struct timespec ts {};
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
  return static_cast<int64_t>(ts.tv_sec) * 1000000000LL + ts.tv_nsec;
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_cn_toside_music_core_CoreModule_nativeMonotonicNs(JNIEnv* env, jclass) {
  return static_cast<jlong>(monotonic_ns());
}

extern "C" JNIEXPORT jlong JNICALL
Java_cn_toside_music_core_CoreModule_nativeEpochMs(JNIEnv* env, jclass) {
  struct timespec ts {};
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return 0;
  return static_cast<jlong>(ts.tv_sec) * 1000LL + ts.tv_nsec / 1000000LL;
}
