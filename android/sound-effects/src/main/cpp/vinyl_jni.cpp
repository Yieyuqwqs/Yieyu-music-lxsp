// Aurora-29：【模拟黑胶 / 胆机】的 JNI 桥（约定与 eq31_jni.cpp 完全一致）
//
//   · 音频线程不分配内存、不加锁、不碰文件、不抛异常；
//   · 参数走 std::atomic，UI 线程随便写都不会撕裂；
//   · 数组用 GetFloatArrayElements 直接拿指针，热路径没有额外复制。

#include <jni.h>

#include <algorithm>
#include <cstdint>
#include <new>

#include "vinyl.h"

namespace {

using yieyu::vinyl::VinylCore;

inline VinylCore* core(jlong handle) {
    return reinterpret_cast<VinylCore*>(static_cast<std::intptr_t>(handle));
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_cn_toside_music_effects_Vinyl_nativeCreate(JNIEnv* env, jclass clazz, jint rate, jint channels) {
    (void) env;
    (void) clazz;
    VinylCore* engine = new (std::nothrow) VinylCore();
    if (engine == nullptr) return 0;
    if (!engine->configure(rate, channels)) {
        delete engine;
        return 0;
    }
    return static_cast<jlong>(reinterpret_cast<std::intptr_t>(engine));
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_effects_Vinyl_nativeRelease(JNIEnv* env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    delete core(handle);
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_effects_Vinyl_nativeSetParams(JNIEnv* env, jclass clazz, jlong handle,
                                                   jfloat amount, jboolean tube, jboolean noise,
                                                   jboolean wow, jboolean hiFi, jboolean enabled,
                                                   jboolean lpf) {
    (void) env;
    (void) clazz;
    VinylCore* engine = core(handle);
    if (engine == nullptr) return;
    engine->setAmount(amount);
    engine->setTube(tube != JNI_FALSE);
    engine->setNoise(noise != JNI_FALSE);
    engine->setWow(wow != JNI_FALSE);
    engine->setQuality(hiFi != JNI_FALSE);
    engine->setEnabled(enabled != JNI_FALSE);
    engine->setLpf(lpf != JNI_FALSE);
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_effects_Vinyl_nativeProcess(JNIEnv* env, jclass clazz, jlong handle,
                                                 jobjectArray channelArrays, jint frames, jint channels) {
    (void) clazz;
    VinylCore* engine = core(handle);
    if (engine == nullptr || channelArrays == nullptr || frames <= 0) return;

    const jsize available = env->GetArrayLength(channelArrays);
    int count = std::min<int>(static_cast<int>(channels), yieyu::vinyl::kMaxCh);
    count = std::min<int>(count, static_cast<int>(available));
    if (count <= 0) return;

    float* data[yieyu::vinyl::kMaxCh] = {nullptr};
    jfloatArray refs[yieyu::vinyl::kMaxCh] = {nullptr};
    int n = static_cast<int>(frames);
    bool ok = true;

    for (int ch = 0; ch < count; ++ch) {
        refs[ch] = static_cast<jfloatArray>(env->GetObjectArrayElement(channelArrays, ch));
        if (refs[ch] == nullptr) {
            ok = false;
            break;
        }
        const jsize len = env->GetArrayLength(refs[ch]);
        if (len < n) n = static_cast<int>(len);
        data[ch] = env->GetFloatArrayElements(refs[ch], nullptr);
        if (data[ch] == nullptr) {
            ok = false;
            break;
        }
    }

    if (ok && n > 0) engine->process(data, n, count);

    for (int ch = 0; ch < count; ++ch) {
        if (refs[ch] == nullptr) continue;
        if (data[ch] != nullptr) env->ReleaseFloatArrayElements(refs[ch], data[ch], 0);
        else env->DeleteLocalRef(refs[ch]);
    }
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_effects_Vinyl_nativeReset(JNIEnv* env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    VinylCore* engine = core(handle);
    if (engine != nullptr) engine->reset();
}

extern "C" JNIEXPORT jint JNICALL
Java_cn_toside_music_effects_Vinyl_nativeOsFactor(JNIEnv* env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    VinylCore* engine = core(handle);
    return engine == nullptr ? 0 : engine->osFactor();
}

extern "C" JNIEXPORT jfloat JNICALL
Java_cn_toside_music_effects_Vinyl_nativeHissDb(JNIEnv* env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    VinylCore* engine = core(handle);
    return engine == nullptr ? 0.f : engine->hissDb();
}

extern "C" JNIEXPORT jfloat JNICALL
Java_cn_toside_music_effects_Vinyl_nativeDriveDb(JNIEnv* env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    VinylCore* engine = core(handle);
    return engine == nullptr ? 0.f : engine->driveDb();
}
