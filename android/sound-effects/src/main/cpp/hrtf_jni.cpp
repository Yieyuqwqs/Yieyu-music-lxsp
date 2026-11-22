// Steam Audio（Apache-2.0）HRTF 双耳渲染桥：
// 立体声 → 一阶 Ambisonics（两个 ±30° 虚拟音箱）→ 按头部朝向旋转 → HRTF 解码成双耳。
// 只在音频线程调用 render()，创建/销毁都在别的线程，热路径零分配。

#include <jni.h>
#include <android/log.h>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <new>

#include "phonon.h"

#define LOG_TAG "YieyuHrtf"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

constexpr IPLint32 kOrder = 1;
constexpr IPLint32 kAmbiChannels = 4;

struct Engine {
    IPLContext context = nullptr;
    IPLHRTF hrtf = nullptr;
    IPLAmbisonicsEncodeEffect encodeLeft = nullptr;
    IPLAmbisonicsEncodeEffect encodeRight = nullptr;
    IPLAmbisonicsRotationEffect rotation = nullptr;
    IPLAmbisonicsBinauralEffect binaural = nullptr;
    IPLAudioBuffer mono{};
    IPLAudioBuffer encoded{};
    IPLAudioBuffer world{};
    IPLAudioBuffer head{};
    IPLAudioBuffer out{};
    IPLCoordinateSpace3 listener{};
    IPLint32 frameSize = 0;
    bool buffersAllocated = false;
    float listenerValues[9] = {1, 0, 0, 0, 1, 0, 0, 0, -1};
};

void destroyEngine(Engine* engine) {
    if (engine == nullptr) return;
    if (engine->context != nullptr) {
        if (engine->binaural != nullptr) iplAmbisonicsBinauralEffectRelease(&engine->binaural);
        if (engine->rotation != nullptr) iplAmbisonicsRotationEffectRelease(&engine->rotation);
        if (engine->encodeLeft != nullptr) iplAmbisonicsEncodeEffectRelease(&engine->encodeLeft);
        if (engine->encodeRight != nullptr) iplAmbisonicsEncodeEffectRelease(&engine->encodeRight);
        if (engine->hrtf != nullptr) iplHRTFRelease(&engine->hrtf);
        if (engine->buffersAllocated) {
            iplAudioBufferFree(engine->context, &engine->mono);
            iplAudioBufferFree(engine->context, &engine->encoded);
            iplAudioBufferFree(engine->context, &engine->world);
            iplAudioBufferFree(engine->context, &engine->head);
            iplAudioBufferFree(engine->context, &engine->out);
        }
        iplContextRelease(&engine->context);
    }
    delete engine;
}

bool allocateBuffers(Engine* engine) {
    const IPLint32 frames = engine->frameSize;
    if (iplAudioBufferAllocate(engine->context, 1, frames, &engine->mono) != IPL_STATUS_SUCCESS) return false;
    if (iplAudioBufferAllocate(engine->context, kAmbiChannels, frames, &engine->encoded) != IPL_STATUS_SUCCESS) return false;
    if (iplAudioBufferAllocate(engine->context, kAmbiChannels, frames, &engine->world) != IPL_STATUS_SUCCESS) return false;
    if (iplAudioBufferAllocate(engine->context, kAmbiChannels, frames, &engine->head) != IPL_STATUS_SUCCESS) return false;
    if (iplAudioBufferAllocate(engine->context, 2, frames, &engine->out) != IPL_STATUS_SUCCESS) return false;
    engine->buffersAllocated = true;
    return true;
}

void clearBuffer(IPLAudioBuffer& buffer) {
    for (IPLint32 ch = 0; ch < buffer.numChannels; ++ch) {
        if (buffer.data[ch] != nullptr) memset(buffer.data[ch], 0, (size_t) buffer.numSamples * sizeof(float));
    }
}

void fillMono(Engine* engine, const float* source, jint frames) {
    float* target = engine->mono.data[0];
    for (IPLint32 i = 0; i < engine->frameSize; ++i) target[i] = i < frames ? source[i] : 0.0f;
}

bool render(Engine* engine, const float* left, const float* right, jint frames, float* outLeft, float* outRight) {
    IPLVector3 worldLeft{-0.5f, 0.0f, -0.8660254f};
    IPLVector3 worldRight{0.5f, 0.0f, -0.8660254f};

    clearBuffer(engine->world);

    IPLAmbisonicsEncodeEffectParams encodeParams{};
    encodeParams.order = kOrder;

    encodeParams.direction = worldLeft;
    fillMono(engine, left, frames);
    iplAmbisonicsEncodeEffectApply(engine->encodeLeft, &encodeParams, &engine->mono, &engine->encoded);
    for (IPLint32 ch = 0; ch < kAmbiChannels; ++ch) {
        for (IPLint32 i = 0; i < engine->frameSize; ++i) engine->world.data[ch][i] += engine->encoded.data[ch][i];
    }

    encodeParams.direction = worldRight;
    fillMono(engine, right, frames);
    iplAmbisonicsEncodeEffectApply(engine->encodeRight, &encodeParams, &engine->mono, &engine->encoded);
    for (IPLint32 ch = 0; ch < kAmbiChannels; ++ch) {
        for (IPLint32 i = 0; i < engine->frameSize; ++i) engine->world.data[ch][i] += engine->encoded.data[ch][i];
    }

    IPLAmbisonicsRotationEffectParams rotationParams{};
    rotationParams.orientation = engine->listener;
    rotationParams.order = kOrder;
    iplAmbisonicsRotationEffectApply(engine->rotation, &rotationParams, &engine->world, &engine->head);

    IPLAmbisonicsBinauralEffectParams binauralParams{};
    binauralParams.hrtf = engine->hrtf;
    binauralParams.order = kOrder;
    iplAmbisonicsBinauralEffectApply(engine->binaural, &binauralParams, &engine->head, &engine->out);

    const float* out0 = engine->out.data[0];
    const float* out1 = engine->out.data[1];
    for (jint i = 0; i < frames; ++i) {
        float l = out0[i];
        float r = out1[i];
        // HRTF 偶发的非有限值会让整块变噪声，这里直接清零
        outLeft[i] = (l > -8.0f && l < 8.0f) ? l : 0.0f;
        outRight[i] = (r > -8.0f && r < 8.0f) ? r : 0.0f;
    }
    return true;
}

bool isFinite(float a[9]) {
    for (int i = 0; i < 9; ++i) {
        if (!(a[i] > -4.0f && a[i] < 4.0f)) return false;
    }
    return true;
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_cn_toside_music_effects_HrtfRenderer_nativeCreate(JNIEnv*, jobject, jint sampleRate, jint frameSize) {
    if (sampleRate < 8000 || sampleRate > 192000 || frameSize <= 0) return 0;

    Engine* engine = new (std::nothrow) Engine();
    if (engine == nullptr) return 0;
    engine->frameSize = frameSize;

    IPLContextSettings contextSettings{};
    contextSettings.version = STEAMAUDIO_VERSION;
    contextSettings.simdLevel = IPL_SIMDLEVEL_NEON;
    if (iplContextCreate(&contextSettings, &engine->context) != IPL_STATUS_SUCCESS) {
        LOGE("iplContextCreate failed");
        destroyEngine(engine);
        return 0;
    }

    IPLAudioSettings audioSettings{sampleRate, frameSize};

    IPLHRTFSettings hrtfSettings{};
    hrtfSettings.type = IPL_HRTFTYPE_DEFAULT;
    hrtfSettings.volume = 1.0f;
    hrtfSettings.normType = IPL_HRTFNORMTYPE_RMS;
    if (iplHRTFCreate(engine->context, &audioSettings, &hrtfSettings, &engine->hrtf) != IPL_STATUS_SUCCESS) {
        LOGE("iplHRTFCreate failed");
        destroyEngine(engine);
        return 0;
    }

    IPLAmbisonicsEncodeEffectSettings encodeSettings{};
    encodeSettings.maxOrder = kOrder;
    if (iplAmbisonicsEncodeEffectCreate(engine->context, &audioSettings, &encodeSettings, &engine->encodeLeft) != IPL_STATUS_SUCCESS ||
        iplAmbisonicsEncodeEffectCreate(engine->context, &audioSettings, &encodeSettings, &engine->encodeRight) != IPL_STATUS_SUCCESS) {
        LOGE("encode effect create failed");
        destroyEngine(engine);
        return 0;
    }

    IPLAmbisonicsRotationEffectSettings rotationSettings{};
    rotationSettings.maxOrder = kOrder;
    if (iplAmbisonicsRotationEffectCreate(engine->context, &audioSettings, &rotationSettings, &engine->rotation) != IPL_STATUS_SUCCESS) {
        LOGE("rotation effect create failed");
        destroyEngine(engine);
        return 0;
    }

    IPLAmbisonicsBinauralEffectSettings binauralSettings{};
    binauralSettings.hrtf = engine->hrtf;
    binauralSettings.maxOrder = kOrder;
    if (iplAmbisonicsBinauralEffectCreate(engine->context, &audioSettings, &binauralSettings, &engine->binaural) != IPL_STATUS_SUCCESS) {
        LOGE("binaural effect create failed");
        destroyEngine(engine);
        return 0;
    }

    if (!allocateBuffers(engine)) {
        LOGE("buffer allocate failed");
        destroyEngine(engine);
        return 0;
    }

    engine->listener.right = IPLVector3{1.0f, 0.0f, 0.0f};
    engine->listener.up = IPLVector3{0.0f, 1.0f, 0.0f};
    engine->listener.ahead = IPLVector3{0.0f, 0.0f, -1.0f};
    engine->listener.origin = IPLVector3{0.0f, 0.0f, 0.0f};

    LOGI("created rate=%d frames=%d version=%d", sampleRate, frameSize, (int) STEAMAUDIO_VERSION);
    return reinterpret_cast<jlong>(engine);
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_effects_HrtfRenderer_nativeDestroy(JNIEnv*, jobject, jlong handle) {
    destroyEngine(reinterpret_cast<Engine*>(handle));
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_effects_HrtfRenderer_nativeSetListener(JNIEnv* env, jobject, jlong handle,
                                                           jfloatArray values) {
    Engine* engine = reinterpret_cast<Engine*>(handle);
    if (engine == nullptr || values == nullptr) return;
    if (env->GetArrayLength(values) < 9) return;
    float local[9];
    env->GetFloatArrayRegion(values, 0, 9, local);
    if (!isFinite(local)) return;
    const float rx = local[0], ry = local[1], rz = local[2];
    const float ux = local[3], uy = local[4], uz = local[5];
    const float ax = local[6], ay = local[7], az = local[8];
    engine->listener.right = IPLVector3{rx, ry, rz};
    engine->listener.up = IPLVector3{ux, uy, uz};
    engine->listener.ahead = IPLVector3{ax, ay, az};
}

extern "C" JNIEXPORT jint JNICALL
Java_cn_toside_music_effects_HrtfRenderer_nativeProcess(JNIEnv* env, jobject, jlong handle,
                                                        jfloatArray leftArray, jfloatArray rightArray,
                                                        jint frames) {
    Engine* engine = reinterpret_cast<Engine*>(handle);
    if (engine == nullptr || leftArray == nullptr || rightArray == nullptr) return -1;
    const jint capacity = engine->frameSize;
    if (frames <= 0 || frames > capacity) return -1;
    if (env->GetArrayLength(leftArray) < capacity || env->GetArrayLength(rightArray) < capacity) return -1;

    jfloat* left = env->GetFloatArrayElements(leftArray, nullptr);
    if (left == nullptr) return -1;
    jfloat* right = env->GetFloatArrayElements(rightArray, nullptr);
    if (right == nullptr) {
        env->ReleaseFloatArrayElements(leftArray, left, JNI_ABORT);
        return -1;
    }

    render(engine, left, right, frames, left, right);

    env->ReleaseFloatArrayElements(leftArray, left, 0);
    env->ReleaseFloatArrayElements(rightArray, right, 0);
    return 0;
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_effects_HrtfRenderer_nativeReset(JNIEnv*, jobject, jlong handle) {
    Engine* engine = reinterpret_cast<Engine*>(handle);
    if (engine == nullptr) return;
    // seek / 暂停恢复时清掉卷积残留，避免状态不连续导致的爆音或静音
    if (engine->encodeLeft != nullptr) iplAmbisonicsEncodeEffectReset(engine->encodeLeft);
    if (engine->encodeRight != nullptr) iplAmbisonicsEncodeEffectReset(engine->encodeRight);
    if (engine->rotation != nullptr) iplAmbisonicsRotationEffectReset(engine->rotation);
    if (engine->binaural != nullptr) iplAmbisonicsBinauralEffectReset(engine->binaural);
}

extern "C" JNIEXPORT jstring JNICALL
Java_cn_toside_music_effects_HrtfRenderer_nativeVersion(JNIEnv* env, jobject) {
    char buffer[64];
    snprintf(buffer, sizeof(buffer), "steamaudio %d.%d.%d", STEAMAUDIO_VERSION_MAJOR,
             STEAMAUDIO_VERSION_MINOR, STEAMAUDIO_VERSION_PATCH);
    return env->NewStringUTF(buffer);
}
