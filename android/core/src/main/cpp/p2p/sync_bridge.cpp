/**
 * 同步引擎的 JNI 桥：锚点、播放头、原生定时调度
 */
#include <jni.h>

#include <string>
#include <vector>

#include "sync_engine.h"

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_core_CoreModule_nativeSyncAnchor(JNIEnv*, jclass, jdouble position_ms,
                                                      jdouble anchor_mono_us, jboolean playing) {
  lxp2p::SyncEngine::instance().set_anchor(static_cast<int64_t>(position_ms),
                                           static_cast<int64_t>(anchor_mono_us),
                                           playing == JNI_TRUE);
}

extern "C" JNIEXPORT jdouble JNICALL
Java_cn_toside_music_core_CoreModule_nativeSyncPlayheadMs(JNIEnv*, jclass) {
  return static_cast<jdouble>(lxp2p::SyncEngine::instance().playhead_ms());
}

extern "C" JNIEXPORT jdouble JNICALL
Java_cn_toside_music_core_CoreModule_nativeSyncLeadMs(JNIEnv*, jclass) {
  return static_cast<jdouble>(lxp2p::SyncEngine::instance().lead_remaining_ms());
}

extern "C" JNIEXPORT jdouble JNICALL
Java_cn_toside_music_core_CoreModule_nativeSyncNowUs(JNIEnv*, jclass) {
  return static_cast<jdouble>(lxp2p::now_mono_us());
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_core_CoreModule_nativeSyncSchedule(JNIEnv*, jclass, jint command_id,
                                                        jint delay_ms) {
  lxp2p::SyncEngine::instance().schedule(command_id, delay_ms);
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_core_CoreModule_nativeSyncCancel(JNIEnv*, jclass, jint command_id) {
  lxp2p::SyncEngine::instance().cancel(command_id);
}

extern "C" JNIEXPORT jintArray JNICALL
Java_cn_toside_music_core_CoreModule_nativeSyncTakeDue(JNIEnv* env, jclass) {
  const std::vector<int32_t> due = lxp2p::SyncEngine::instance().take_due();
  jintArray out = env->NewIntArray(static_cast<jsize>(due.size()));
  if (out == nullptr || due.empty()) return out;
  env->SetIntArrayRegion(out, 0, static_cast<jsize>(due.size()),
                         reinterpret_cast<const jint*>(due.data()));
  return out;
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_core_CoreModule_nativeSyncClear(JNIEnv*, jclass) {
  lxp2p::SyncEngine::instance().clear();
}
