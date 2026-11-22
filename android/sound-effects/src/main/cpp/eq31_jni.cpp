// Aurora-27：31 段均衡器的 JNI 桥
//
// 只做三件事：建/删句柄、下发参数、按声道指针就地处理。
// 音频线程上的调用约定：
//   · 不分配内存、不加锁、不碰文件、不抛异常；
//   · 参数走 std::atomic（每条 31 个 float + 3 个标志），UI 线程随便写都不会撕裂；
//   · 数组用 GetFloatArrayElements 直接拿指针，Release(..., 0) 拷回，热路径没有额外复制。

#include <jni.h>

#include <algorithm>
#include <cstdint>
#include <new>

#include "eq31.h"

namespace {

using yieyu::Eq31Core;

inline Eq31Core* core(jlong handle) {
    return reinterpret_cast<Eq31Core*>(static_cast<std::intptr_t>(handle));
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_cn_toside_music_effects_Eq31_nativeCreate(JNIEnv* env, jclass clazz, jint rate, jint channels) {
    (void) env;
    (void) clazz;
    Eq31Core* engine = new (std::nothrow) Eq31Core();
    if (engine == nullptr) return 0;
    if (!engine->configure(rate, channels)) {
        delete engine;
        return 0;
    }
    return static_cast<jlong>(reinterpret_cast<std::intptr_t>(engine));
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_effects_Eq31_nativeRelease(JNIEnv* env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    delete core(handle);
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_effects_Eq31_nativeSetParams(JNIEnv* env, jclass clazz, jlong handle,
                                                  jfloatArray gains10, jfloatArray gains31,
                                                  jint bands, jboolean enabled, jboolean headroom) {
    (void) clazz;
    Eq31Core* engine = core(handle);
    if (engine == nullptr) return;

    float ten[yieyu::kTenBands] = {0.f};
    float wide[yieyu::kMaxBands] = {0.f};

    if (gains10 != nullptr) {
        const jsize len = env->GetArrayLength(gains10);
        const jsize n = std::min<jsize>(len, yieyu::kTenBands);
        if (n > 0) env->GetFloatArrayRegion(gains10, 0, n, ten);
    }
    if (gains31 != nullptr) {
        const jsize len = env->GetArrayLength(gains31);
        const jsize n = std::min<jsize>(len, yieyu::kMaxBands);
        if (n > 0) env->GetFloatArrayRegion(gains31, 0, n, wide);
    }

    engine->setGains10(ten);
    engine->setGains31(wide);
    engine->setBands(static_cast<int>(bands));
    engine->setEnabled(enabled != JNI_FALSE);
    engine->setHeadroom(headroom != JNI_FALSE);
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_effects_Eq31_nativeProcess(JNIEnv* env, jclass clazz, jlong handle,
                                                jobjectArray channelArrays, jint frames, jint channels) {
    (void) clazz;
    Eq31Core* engine = core(handle);
    if (engine == nullptr || channelArrays == nullptr || frames <= 0) return;

    const jsize available = env->GetArrayLength(channelArrays);
    int count = std::min<int>(static_cast<int>(channels), yieyu::kMaxChannels);
    count = std::min<int>(count, static_cast<int>(available));
    if (count <= 0) return;

    float* data[yieyu::kMaxChannels] = {nullptr};
    jfloatArray refs[yieyu::kMaxChannels] = {nullptr};
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
Java_cn_toside_music_effects_Eq31_nativeReset(JNIEnv* env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    Eq31Core* engine = core(handle);
    if (engine != nullptr) engine->reset();
}

extern "C" JNIEXPORT jfloat JNICALL
Java_cn_toside_music_effects_Eq31_nativeTrimDb(JNIEnv* env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    Eq31Core* engine = core(handle);
    return engine == nullptr ? 0.f : engine->trimDb();
}

extern "C" JNIEXPORT jint JNICALL
Java_cn_toside_music_effects_Eq31_nativeLiveBands(JNIEnv* env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    Eq31Core* engine = core(handle);
    return engine == nullptr ? 0 : engine->liveBands();
}
