/**
 * 一起听直连通道的 JNI 桥（纯 C++ 核心，无第三方依赖）
 *
 * JS 侧用法：
 *   start(host, port, timeout) → "ip:port"   // STUN 拿公网映射
 *   connect(ip, port)                        // 打洞
 *   send(bytes) / poll(timeoutMs) → bytes    // 控制消息收发
 */
#include <jni.h>

#include <mutex>
#include <string>
#include <vector>

#include "p2p_peer.h"

namespace {
lxp2p::UdpPeer g_peer;
std::mutex g_mutex;

std::string to_std(JNIEnv* env, jstring value) {
  if (value == nullptr) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  std::string out = chars ? chars : "";
  if (chars) env->ReleaseStringUTFChars(value, chars);
  return out;
}

jstring to_java(JNIEnv* env, const std::string& value) { return env->NewStringUTF(value.c_str()); }
}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_cn_toside_music_core_CoreModule_nativeP2PStart(JNIEnv* env, jclass, jstring host, jint port,
                                                    jint timeout_ms) {
  std::lock_guard<std::mutex> lock(g_mutex);
  const std::string stun_host = to_std(env, host);
  std::string error;
  if (!g_peer.start(stun_host.c_str(), static_cast<uint16_t>(port), timeout_ms, error)) {
    return to_java(env, "ERR:" + error);
  }
  return to_java(env, g_peer.mapped());
}

extern "C" JNIEXPORT jstring JNICALL
Java_cn_toside_music_core_CoreModule_nativeP2PLocalIp(JNIEnv* env, jclass) {
  return to_java(env, g_peer.private_ip());
}

extern "C" JNIEXPORT jboolean JNICALL
Java_cn_toside_music_core_CoreModule_nativeP2PConnect(JNIEnv* env, jclass, jstring ip, jint port) {
  std::lock_guard<std::mutex> lock(g_mutex);
  const std::string remote = to_std(env, ip);
  return g_peer.connect_to(remote.c_str(), static_cast<uint16_t>(port)) ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jboolean JNICALL
Java_cn_toside_music_core_CoreModule_nativeP2PSend(JNIEnv* env, jclass, jbyteArray payload) {
  if (payload == nullptr) return JNI_FALSE;
  const jsize length = env->GetArrayLength(payload);
  if (length <= 0 || length > 1200) return JNI_FALSE;
  std::vector<uint8_t> buffer(static_cast<size_t>(length));
  env->GetByteArrayRegion(payload, 0, length, reinterpret_cast<jbyte*>(buffer.data()));
  return g_peer.send_payload(buffer.data(), buffer.size()) ? JNI_TRUE : JNI_FALSE;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_cn_toside_music_core_CoreModule_nativeP2PPoll(JNIEnv* env, jclass, jint timeout_ms) {
  uint8_t buffer[1200];
  const size_t got = g_peer.poll(buffer, sizeof(buffer), timeout_ms);
  if (got == 0) return nullptr;
  jbyteArray out = env->NewByteArray(static_cast<jsize>(got));
  if (out == nullptr) return nullptr;
  env->SetByteArrayRegion(out, 0, static_cast<jsize>(got), reinterpret_cast<const jbyte*>(buffer));
  return out;
}

extern "C" JNIEXPORT jstring JNICALL
Java_cn_toside_music_core_CoreModule_nativeP2PStats(JNIEnv* env, jclass) {
  const lxp2p::PeerStats stats = g_peer.stats();
  std::string text = "sent=" + std::to_string(stats.sent) + " recv=" + std::to_string(stats.received) +
                     " drop=" + std::to_string(stats.dropped) + " connected=" + (stats.connected ? "1" : "0") +
                     " remote=" + stats.remote;
  return to_java(env, text);
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_core_CoreModule_nativeP2PStop(JNIEnv*, jclass) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_peer.stop();
}
