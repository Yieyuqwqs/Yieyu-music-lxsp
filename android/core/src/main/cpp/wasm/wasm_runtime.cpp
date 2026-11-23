// 客户端内嵌 WASM 运行时（wasm3 解释器）——用来安全执行「音源插件」。
//
// 为什么必须原生：Hermes 没有 WebAssembly，JS 里跑不了 wasm；只能在 App 的原生层塞一个解释器。
// 为什么用 wasm3：纯 C、无依赖、无 JIT，Android 上体积小；沙箱由 wasm 语义保证（没有隐式系统调用）。
//
// 插件 ABI（很小，够用）：
//   导出  memory
//   导出  alloc(i32 size) -> i32                      // 返回值指针
//   导出  resolve(i32 inPtr, i32 inLen) -> i32        // 返回 NUL 结尾 JSON 的指针
//   导入  env.http(i32 urlPtr, i32 urlLen, i32 bodyPtr, i32 bodyLen) -> i32   // 返回 JSON 指针（0 = 失败）
//   导入  env.log(i32 ptr, i32 len)
//
// 网络只能走 env.http -> Java 侧 OkHttp（同步），插件拿不到文件/进程/其他权限。

#include <jni.h>
#include <android/log.h>
#include <cstring>
#include <new>
#include <cstdlib>
#include <string>

#include "wasm3.h"
#include "m3_env.h"
#include "m3_api_defs.h"

#define WASM_TAG "YieyuWasm"
#define WASM_LOGE(...) __android_log_print(ANDROID_LOG_ERROR, WASM_TAG, __VA_ARGS__)
#define WASM_LOGI(...) __android_log_print(ANDROID_LOG_INFO, WASM_TAG, __VA_ARGS__)

namespace {

struct WasmPlugin {
  IM3Environment env = nullptr;
  IM3Runtime runtime = nullptr;
  IM3Module module = nullptr;
  IM3Function resolve = nullptr;
  IM3Function alloc = nullptr;
  uint8_t* memory = nullptr;
  uint32_t memorySize = 0;
};

JavaVM* g_vm = nullptr;

// 插件传进来的指针一律当敌意输入：先验范围，再解引用
inline bool guest_range(IM3Runtime runtime, uint32_t ptr, uint32_t len, uint8_t** base, uint32_t* size_out) {
  uint32_t size = 0;
  uint8_t* memory = runtime ? m3_GetMemory(runtime, &size, 0) : nullptr;
  if (!memory) return false;
  if (ptr > size) return false;
  if (len > size - ptr) return false;
  *base = memory;
  *size_out = size;
  return true;
}
thread_local JNIEnv* t_env = nullptr;
thread_local WasmPlugin* t_plugin = nullptr;

// 调 Java 侧同步 HTTP：cn.toside.music.core.CoreModule.wasmHttp(url, body) -> json
std::string call_java_http(const std::string& url, const std::string& body) {
  JNIEnv* env = t_env;
  if (!env) return std::string();
  jclass cls = env->FindClass("cn/toside/music/core/CoreModule");
  if (!cls) return std::string();
  jmethodID mid = env->GetStaticMethodID(cls, "wasmHttp", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;");
  if (!mid) { env->DeleteLocalRef(cls); return std::string(); }
  jstring jurl = env->NewStringUTF(url.c_str());
  jstring jbody = env->NewStringUTF(body.c_str());
  jstring jout = (jstring) env->CallStaticObjectMethod(cls, mid, jurl, jbody);
  std::string out;
  if (jout) {
    const char* chars = env->GetStringUTFChars(jout, nullptr);
    if (chars) {
      out.assign(chars);
      env->ReleaseStringUTFChars(jout, chars);
    }
    env->DeleteLocalRef(jout);
  }
  env->DeleteLocalRef(jurl);
  env->DeleteLocalRef(jbody);
  env->DeleteLocalRef(cls);
  if (env->ExceptionCheck()) env->ExceptionClear();
  return out;
}

// 把字符串写进 guest 内存（通过 guest 的 alloc），返回 guest 指针
uint32_t write_guest_string(WasmPlugin* plugin, const std::string& text) {
  if (!plugin || !plugin->alloc) return 0;
  uint32_t ptr = 0;
  uint32_t arg = (uint32_t) text.size() + 1;
  if (m3_CallV(plugin->alloc, arg) != m3Err_none) return 0;
  m3_GetResultsV(plugin->alloc, &ptr);
  if (!ptr) return 0;
  uint8_t* memory = nullptr;
  uint32_t size = 0;
  if (!guest_range(plugin->runtime, ptr, arg, &memory, &size)) return 0;
  memcpy(memory + ptr, text.c_str(), arg);
  return ptr;
}

const void* host_http(IM3Runtime runtime, IM3ImportContext ctx, uint64_t* sp, void* mem) {
  auto* plugin = t_plugin;
  if (!plugin || !mem) return nullptr;
  uint32_t urlPtr = (uint32_t) sp[0];
  uint32_t urlLen = (uint32_t) sp[1];
  uint32_t bodyPtr = (uint32_t) sp[2];
  uint32_t bodyLen = (uint32_t) sp[3];
  uint8_t* base = nullptr;
  uint32_t size = 0;
  if (!guest_range(runtime, urlPtr, urlLen, &base, &size)) m3ApiReturnValue(0u);
  if (urlLen > 2048) m3ApiReturnValue(0u);
  if (bodyLen && !guest_range(runtime, bodyPtr, bodyLen, &base, &size)) m3ApiReturnValue(0u);
  if (bodyLen > 64 * 1024) m3ApiReturnValue(0u);
  std::string url(reinterpret_cast<char*>(base + urlPtr), urlLen);
  std::string body = bodyLen ? std::string(reinterpret_cast<char*>(base + bodyPtr), bodyLen) : std::string();
  std::string response = call_java_http(url, body);
  uint32_t outPtr = write_guest_string(plugin, response.empty() ? "{\"status\":0}" : response);
  m3ApiReturnValue(outPtr);
}

const void* host_log(IM3Runtime runtime, IM3ImportContext ctx, uint64_t* sp, void* mem) {
  if (!mem) return nullptr;
  uint32_t ptr = (uint32_t) sp[0];
  uint32_t len = (uint32_t) sp[1];
  (void) mem;
  uint8_t* base = nullptr;
  uint32_t size = 0;
  if (!guest_range(runtime, ptr, len, &base, &size)) return nullptr;
  if (len > 4096) len = 4096;
  std::string text(reinterpret_cast<char*>(base + ptr), len);
  WASM_LOGI("plugin: %s", text.c_str());
  return nullptr;
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  g_vm = vm;
  return JNI_VERSION_1_6;
}

extern "C" JNIEXPORT jlong JNICALL
Java_cn_toside_music_core_CoreModule_nativeWasmLoad(JNIEnv* env, jclass, jbyteArray bytes) {
  t_env = env;
  if (!bytes) return 0;
  jsize len = env->GetArrayLength(bytes);
  auto* code = static_cast<uint8_t*>(malloc((size_t) len));
  if (!code) return 0;
  env->GetByteArrayRegion(bytes, 0, len, reinterpret_cast<jbyte*>(code));

  auto* plugin = new (std::nothrow) WasmPlugin();
  if (!plugin) { free(code); return 0; }
  plugin->env = m3_NewEnvironment();
  plugin->runtime = plugin->env ? m3_NewRuntime(plugin->env, 64 * 1024, nullptr) : nullptr;
  if (!plugin->runtime) {
    if (plugin->env) m3_FreeEnvironment(plugin->env);
    delete plugin;
    free(code);
    return 0;
  }
  M3Result result = m3_ParseModule(plugin->env, &plugin->module, code, (uint32_t) len);
  if (!result) result = m3_LoadModule(plugin->runtime, plugin->module);
  if (!result) result = m3_FindFunction(&plugin->resolve, plugin->runtime, "resolve");
  if (!result) result = m3_FindFunction(&plugin->alloc, plugin->runtime, "alloc");
  if (!result) result = m3_LinkRawFunction(plugin->module, "env", "http", "i(*iiii)", &host_http);
  if (!result) m3_LinkRawFunction(plugin->module, "env", "log", "v(*ii)", &host_log);
  free(code);
  if (result) {
    WASM_LOGE("load failed: %s", result);
    m3_FreeRuntime(plugin->runtime);
    m3_FreeEnvironment(plugin->env);
    delete plugin;
    return 0;
  }
  plugin->memory = m3_GetMemory(plugin->runtime, &plugin->memorySize, 0);
  return reinterpret_cast<jlong>(plugin);
}

extern "C" JNIEXPORT jstring JNICALL
Java_cn_toside_music_core_CoreModule_nativeWasmResolve(JNIEnv* env, jclass, jlong handle, jstring input) {
  t_env = env;
  auto* plugin = reinterpret_cast<WasmPlugin*>(handle);
  if (!plugin || !input) return env->NewStringUTF("");
  t_plugin = plugin;

  const char* chars = env->GetStringUTFChars(input, nullptr);
  std::string payload = chars ? chars : "";
  if (chars) env->ReleaseStringUTFChars(input, chars);

  uint32_t inPtr = write_guest_string(plugin, payload);
  if (!inPtr) { t_plugin = nullptr; return env->NewStringUTF(""); }

  M3Result result = m3_CallV(plugin->resolve, inPtr, (uint32_t) payload.size());
  if (result) {
    WASM_LOGE("resolve trapped: %s", result);
    t_plugin = nullptr;
    return env->NewStringUTF("");
  }
  uint32_t outPtr = 0;
  m3_GetResultsV(plugin->resolve, &outPtr);
  std::string out;
  if (outPtr) {
    uint8_t* memory = nullptr;
    uint32_t size = 0;
    if (guest_range(plugin->runtime, outPtr, 0, &memory, &size) && outPtr < size) {
      const char* text = reinterpret_cast<char*>(memory + outPtr);
      size_t max = size - outPtr;
      size_t len = 0;
      while (len < max && text[len] != 0) len++;
      out.assign(text, len);
    }
  }
  t_plugin = nullptr;
  return env->NewStringUTF(out.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_cn_toside_music_core_CoreModule_nativeWasmFree(JNIEnv*, jclass, jlong handle) {
  auto* plugin = reinterpret_cast<WasmPlugin*>(handle);
  if (!plugin) return;
  if (plugin->runtime) m3_FreeRuntime(plugin->runtime);
  if (plugin->env) m3_FreeEnvironment(plugin->env);
  delete plugin;
}
