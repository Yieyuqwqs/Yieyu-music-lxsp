// JNI 边界（M0）
//
// 这一层只做三件事：拿字符串 → 交给 Runtime → 立刻返回。
// 任何解析、IO、DB、网络都必须出现在 Runtime 的线程里，绝不在这里。
//
// 命名用「mangled name」而不是 JNI_OnLoad + RegisterNatives：
// 本项目 sound-effects 的 JNI 全是 mangled name，属于已验证路径；
// RegisterNatives 需要在 JNI_OnLoad 里 FindClass，类加载器上下文偶发不稳，M0 不冒这个险。
#include <jni.h>

#include <android/log.h>

#include <string>

#include "runtime/core_runtime.h"

#define LOG_TAG "YieyuCoreJni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

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

inline void withRuntime(JNIEnv* env, jobject thiz) {
    yieyu::core::Runtime::instance().ensureStarted(env, thiz);
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL Java_cn_toside_music_core_CoreModule_nativeInit(
        JNIEnv* env, jobject thiz, jstring storageDir) {
    withRuntime(env, thiz);
    const std::string dir = fromJString(env, storageDir);
    if (dir.empty()) return;
    LOGI("init: storageDir=%s", dir.c_str());
    yieyu::core::Runtime::instance().setStorageDir(dir);
}

JNIEXPORT void JNICALL Java_cn_toside_music_core_CoreModule_nativePost(
        JNIEnv* env, jobject thiz, jstring op, jstring payload, jdouble seq) {
    withRuntime(env, thiz);
    auto& runtime = yieyu::core::Runtime::instance();
    if (!runtime.ready()) return;
    runtime.post(fromJString(env, op), fromJString(env, payload), seq);
}

JNIEXPORT void JNICALL Java_cn_toside_music_core_CoreModule_nativeRequest(
        JNIEnv* env, jobject thiz, jstring op, jstring payload, jlong id) {
    withRuntime(env, thiz);
    auto& runtime = yieyu::core::Runtime::instance();
    if (!runtime.ready()) return;
    runtime.request(fromJString(env, op), fromJString(env, payload), id);
}

JNIEXPORT void JNICALL Java_cn_toside_music_core_CoreModule_nativeSubscribe(
        JNIEnv* env, jobject thiz, jstring topic, jint maxHz) {
    withRuntime(env, thiz);
    yieyu::core::Runtime::instance().subscribe(fromJString(env, topic), maxHz);
}

JNIEXPORT void JNICALL Java_cn_toside_music_core_CoreModule_nativeUnsubscribe(
        JNIEnv* env, jobject thiz, jstring topic) {
    (void)thiz;
    yieyu::core::Runtime::instance().unsubscribe(fromJString(env, topic));
}

JNIEXPORT void JNICALL Java_cn_toside_music_core_CoreModule_nativeSetForeground(
        JNIEnv* env, jobject thiz, jboolean foreground) {
    withRuntime(env, thiz);
    yieyu::core::Runtime::instance().setForeground(foreground == JNI_TRUE);
}

JNIEXPORT void JNICALL Java_cn_toside_music_core_CoreModule_nativeStop(
        JNIEnv* env, jobject thiz) {
    (void)env;
    (void)thiz;
    LOGI("nativeStop from JS");
    yieyu::core::Runtime::instance().stop();
}

JNIEXPORT jstring JNICALL Java_cn_toside_music_core_CoreModule_nativeStats(
        JNIEnv* env, jobject thiz) {
    withRuntime(env, thiz);
    const std::string stats = yieyu::core::Runtime::instance().stats();
    return env->NewStringUTF(stats.c_str());
}

}  // extern "C"
