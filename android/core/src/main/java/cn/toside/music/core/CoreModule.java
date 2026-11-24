package cn.toside.music.core;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import org.json.JSONObject;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Yieyu Core 的 RN 门面（M0 地基）。
 *
 * 三条硬约束（见 ARCH_FAT_CORE.md §4）：
 * 1. 这里**不写业务**：所有方法只做参数转交，必须 <0.5ms 返回。
 * 2. 事件只能通过 onEvent() 投递到 DeviceEventEmitter，绝不阻塞等待 JS。
 * 3. 每个 request 都有 3s 硬超时，绝不留下永不 resolve 的 Promise。
 */
public final class CoreModule extends ReactContextBaseJavaModule implements CoreCallback {
  public static final String NAME = "YieyuCore";
  private static final String TAG = "YieyuCore";
  /** 事件前缀：JS 侧统一订阅 "YieyuCore:<topic>" */
  public static final String EVENT_PREFIX = "YieyuCore:";
  private static final long REQUEST_TIMEOUT_MS = 3000L;

  private static final boolean LOADED;
  private static String loadError = "";

  static {
    boolean loaded = false;
    try {
      System.loadLibrary("yieyu_core");
      loaded = true;
    } catch (Throwable error) {
      loadError = error.getClass().getSimpleName() + ": " + error.getMessage();
      Log.e(TAG, "loadLibrary failed: " + loadError);
    }
    LOADED = loaded;
  }

  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private final Map<Long, Promise> pending = new HashMap<>();
  private long requestSeq = 1;
  private int emitFailures = 0;

  public CoreModule(ReactApplicationContext context) {
    super(context);
    if (!LOADED) return;
    // 存储目录交给 C++（M1）：文件读写绝不能发生在 JS 线程
    final String dir = context.getFilesDir().getAbsolutePath() + "/core";
    Thread init = new Thread(new Runnable() {
      @Override
      public void run() {
        try {
          nativeInit(dir);
        } catch (Throwable error) {
          Log.e(TAG, "core init failed", error);
        }
      }
    }, "yieyu-core-init");
    init.setDaemon(true);
    init.start();
  }

  @Override
  public String getName() {
    return NAME;
  }

  public static boolean available() {
    return LOADED;
  }

  public static String loadErrorText() {
    return loadError;
  }

  // ------------------------------------------------------------ JS → C++

  @ReactMethod
  public void post(String op, String payload, double seq) {
    if (!LOADED) return;
    nativePost(op == null ? "" : op, payload == null ? "{}" : payload, seq);
  }

  @ReactMethod
  public void request(final String op, String payload, final Promise promise) {
    if (!LOADED) {
      promise.reject("CORE_UNAVAILABLE", loadError);
      return;
    }
    final long id;
    synchronized (pending) {
      id = requestSeq++;
      pending.put(id, promise);
    }
    nativeRequest(op == null ? "" : op, payload == null ? "{}" : payload, id);
    // 超时兜底：C++ 侧真出问题时，JS 也不会被挂住
    mainHandler.postDelayed(new Runnable() {
      @Override
      public void run() {
        Promise stale;
        synchronized (pending) {
          stale = pending.remove(id);
        }
        if (stale != null) stale.reject("CORE_TIMEOUT", "core request timeout: " + op);
      }
    }, REQUEST_TIMEOUT_MS);
  }

  @ReactMethod
  public void subscribe(String topic, int maxHz) {
    if (!LOADED) return;
    nativeSubscribe(topic == null ? "" : topic, maxHz);
  }

  @ReactMethod
  public void unsubscribe(String topic) {
    if (!LOADED) return;
    nativeUnsubscribe(topic == null ? "" : topic);
  }

  @ReactMethod
  public void setForeground(boolean foreground) {
    if (!LOADED) return;
    nativeSetForeground(foreground);
  }

  /** JS 卸载 / reload 前调用，保证 GlobalRef 与线程都干净退出（内存红线） */
  @ReactMethod
  public void stopCore() {
    if (!LOADED) return;
    try {
      nativeStop();
    } catch (Throwable error) {
      Log.e(TAG, "stopCore failed", error);
    }
  }

  @ReactMethod
  public void getStats(Promise promise) {
    if (!LOADED) {
      promise.reject("CORE_UNAVAILABLE", loadError);
      return;
    }
    try {
      promise.resolve(nativeStats());
    } catch (Throwable error) {
      promise.reject("CORE_STATS_FAILED", error);
    }
  }

  // ------------------------------------------------------------ C++ → JS（core-disp 线程）

  @Override
  public void onEvent(String topic, String json) {
    if (emitFailures > 3) return;   // 宿主已死（reload 后）：不再刷日志，等新宿主重建
    ReactApplicationContext context = getReactApplicationContext();
    if (context == null) return;
    try {
      context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
          .emit(EVENT_PREFIX + topic, json);
    } catch (Throwable error) {
      // 绝不让异常穿过 JNI：这里吞掉并降级
      emitFailures++;
      Log.e(TAG, "emit failed: " + topic, error);
    }
  }

  @Override
  public void onResponse(long requestId, String json) {
    Promise promise;
    synchronized (pending) {
      promise = pending.remove(requestId);
    }
    if (promise != null) promise.resolve(json);
  }

  // ------------------------------------------------------------ native

  private native void nativeInit(String storageDir);
  private native void nativePost(String op, String payload, double seq);
  private native void nativeRequest(String op, String payload, long id);
  private native void nativeSubscribe(String topic, int maxHz);
  private native void nativeUnsubscribe(String topic);
  private native void nativeSetForeground(boolean foreground);
  private native void nativeStop();
  private native String nativeStats();
  // ------------------------------------------------ WASM 音源插件（沙箱）
  //
  // 插件跑在 wasm3 解释器里（原生，Hermes 没有 WebAssembly）。
  // 它能做的事只有两件：调 env.http 发同步 HTTP、调 env.log 打日志；
  // 文件、进程、其他系统能力一律拿不到 —— 这是相对当年 QuickJS 脚本的实质改进。

  private static final OkHttpClient WASM_CLIENT = new OkHttpClient.Builder()
      .connectTimeout(8, TimeUnit.SECONDS)
      .readTimeout(20, TimeUnit.SECONDS)
      .build();

  /** 单调时钟（纳秒）：一起听做对齐/时延计算用，不受系统校时影响 */
  @ReactMethod
  public void nowMonotonicNs(Promise promise) {
    try {
      promise.resolve((double) nativeMonotonicNs());
    } catch (Throwable error) {
      promise.reject("E_CLOCK", error);
    }
  }

  @ReactMethod
  public void nowEpochMs(Promise promise) {
    try {
      promise.resolve((double) nativeEpochMs());
    } catch (Throwable error) {
      promise.reject("E_CLOCK", error);
    }
  }

  private static native long nativeMonotonicNs();
  private static native long nativeEpochMs();
  @ReactMethod
  public void wasmLoad(String base64, Promise promise) {
    if (!LOADED) {
      promise.reject("wasm", "native 未加载: " + loadError);
      return;
    }
    try {
      byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
      long handle = nativeWasmLoad(bytes);
      if (handle == 0) promise.reject("wasm", "插件加载失败：不是合法 wasm，或缺少 alloc/resolve 导出");
      else promise.resolve((double) handle);
    } catch (Throwable error) {
      promise.reject("wasm", error);
    }
  }

  @ReactMethod
  public void wasmResolve(double handle, String source, String musicId, String quality, Promise promise) {
    if (!LOADED) {
      promise.reject("wasm", "native 未加载: " + loadError);
      return;
    }
    try {
      promise.resolve(nativeWasmResolve((long) handle, source == null ? "" : source, musicId == null ? "" : musicId, quality == null ? "" : quality));
    } catch (Throwable error) {
      promise.reject("wasm", error);
    }
  }

  @ReactMethod
  public void wasmFree(double handle, Promise promise) {
    try {
      nativeWasmFree((long) handle);
    } catch (Throwable ignored) {
      // 释放失败不影响业务
    }
    promise.resolve(null);
  }

  private static native long nativeWasmLoad(byte[] bytes);

  private static native String nativeWasmResolve(long handle, String source, String musicId, String quality);

  private static native void nativeWasmFree(long handle);

  /**
   * 插件唯一的外网出口（C++ 侧通过 JNI 同步调用）。
   * 入参 requestJson: {"method":"POST","headers":{...},"body":"..."}
   * 出参: {"status":200,"body":"..."}；失败 status=0。
   */
  public static String wasmHttp(String url, String requestJson) {
    try {
      JSONObject spec = new JSONObject(requestJson == null || requestJson.isEmpty() ? "{}" : requestJson);
      String method = spec.optString("method", "GET").toUpperCase();
      String body = spec.optString("body", "");
      Request.Builder builder = new Request.Builder().url(url).header("User-Agent", "YieyuMusic-Plugin");
      JSONObject headers = spec.optJSONObject("headers");
      if (headers != null) {
        java.util.Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
          String key = keys.next();
          builder.header(key, String.valueOf(headers.opt(key)));
        }
      }
      if ("POST".equals(method)) {
        RequestBody requestBody = RequestBody.create(body, MediaType.parse("application/json"));
        builder.post(requestBody);
      }
      Response response = WASM_CLIENT.newCall(builder.build()).execute();
      String text;
      try {
        text = response.body() == null ? "" : response.body().string();
      } finally {
        response.close();
      }
      JSONObject out = new JSONObject();
      out.put("status", response.code());
      out.put("body", text);
      return out.toString();
    } catch (Throwable error) {
      Log.w(TAG, "wasm http failed: " + error.getClass().getSimpleName(), error);
      return "{\"status\":0,\"body\":\"\"}";
    }
  }
}
