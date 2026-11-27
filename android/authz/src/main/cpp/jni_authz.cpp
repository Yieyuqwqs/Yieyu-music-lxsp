// JNI 边界：只做「字符串进 → 字符串出」，不碰线程、不碰 IO。
// 类名固定为 cn.toside.music.authz.AuthzModule（mangled name，不用 RegisterNatives）。
#include <jni.h>

#include <cstdint>
#include <cstdio>
#include <string>

#include "authz_core.h"

namespace {

std::string fromJString(JNIEnv* env, jstring value) {
  if (value == nullptr) return std::string();
  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) {
    if (env->ExceptionCheck()) env->ExceptionClear();
    return std::string();
  }
  std::string result(chars);
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

jstring toJString(JNIEnv* env, const std::string& value) {
  return env->NewStringUTF(value.c_str());
}

}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL
Java_cn_toside_music_authz_AuthzModule_nativeDeviceCode(JNIEnv* env, jclass, jstring seed) {
  return toJString(env, yieyu::authz::deviceCode(fromJString(env, seed)));
}

JNIEXPORT jstring JNICALL
Java_cn_toside_music_authz_AuthzModule_nativeEntryKey(JNIEnv* env, jclass, jstring device_code) {
  return toJString(env, yieyu::authz::entryKey(fromJString(env, device_code)));
}

JNIEXPORT jstring JNICALL
Java_cn_toside_music_authz_AuthzModule_nativeSignText(JNIEnv* env, jclass, jstring text) {
  return toJString(env, yieyu::authz::signText(fromJString(env, text)));
}

JNIEXPORT jstring JNICALL
Java_cn_toside_music_authz_AuthzModule_nativeQqKey(JNIEnv* env, jclass, jstring qq) {
  return toJString(env, yieyu::authz::qqKey(fromJString(env, qq)));
}

JNIEXPORT jstring JNICALL
Java_cn_toside_music_authz_AuthzModule_nativeMigrateExport(JNIEnv* env, jclass, jstring device_code,
                                                           jlong exp_ms, jlong now_sec) {
  const yieyu::authz::Migration result = yieyu::authz::migrateExport(
      fromJString(env, device_code), static_cast<int64_t>(exp_ms), static_cast<int64_t>(now_sec), 0);
  if (!result.ok) return toJString(env, "err|" + result.reason);
  return toJString(env, result.code);
}

JNIEXPORT jstring JNICALL
Java_cn_toside_music_authz_AuthzModule_nativeMigrateImport(JNIEnv* env, jclass, jstring code, jlong now_sec) {
  const yieyu::authz::Migration result =
      yieyu::authz::migrateImport(fromJString(env, code), static_cast<int64_t>(now_sec));
  if (!result.ok) return toJString(env, "err|" + result.reason);

  char buffer[160];
  // exp_day / exp_ms / issued_sec / src_tag / nonce
  const int64_t exp_ms = yieyu::authz::expMsFromDay(result.exp_day);
  snprintf(buffer, sizeof(buffer), "ok|%u|%lld|%lld|%s|%u", static_cast<unsigned>(result.exp_day),
           static_cast<long long>(exp_ms), static_cast<long long>(result.issued_sec), result.src_tag.c_str(),
           static_cast<unsigned>(result.nonce));
  return toJString(env, std::string(buffer));
}

JNIEXPORT jstring JNICALL
Java_cn_toside_music_authz_AuthzModule_nativeSelfTest(JNIEnv* env, jclass) {
  return toJString(env, yieyu::authz::selfTest());
}

}  // extern "C"
