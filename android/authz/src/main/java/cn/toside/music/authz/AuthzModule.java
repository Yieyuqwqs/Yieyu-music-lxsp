package cn.toside.music.authz;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.util.Log;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.nio.charset.Charset;

import javax.crypto.Cipher;

/**
 * Yieyu 授权门面（JS 名字：YieyuAuth）。
 *
 * 分工：
 *   · 设备码 / 白名单条目键 / 迁移码  → C++（libyieyu_authz.so，密钥在那边）
 *   · 指纹（BiometricPrompt）+ Keystore 加密令牌 + 锁屏广播 → 这里
 *
 * 三条硬约束：
 * 1. 任何加密令牌的读写都必须先过指纹，不存在「验一次指纹永久放行」的路径。
 * 2. 令牌明文只在 JS 内存里活；落盘永远是 Keystore 密文。
 * 3. ACTION_SCREEN_OFF 立刻抛事件，JS 收到就清内存令牌（锁屏熔断）。
 */
public final class AuthzModule extends ReactContextBaseJavaModule {
  public static final String NAME = "YieyuAuth";
  public static final String EVENT_SCREEN_OFF = "YieyuAuth:screenOff";
  private static final String TAG = "YieyuAuthz";
  private static final String PREF_DEVICE = "yieyu_authz_device";
  private static final String FIELD_SEED = "seed";
  private static final Charset UTF8 = Charset.forName("UTF-8");

  private static final boolean LOADED;
  private static final String LOAD_ERROR;

  static {
    boolean loaded = false;
    String error = "";
    try {
      System.loadLibrary("yieyu_authz");
      loaded = true;
    } catch (Throwable cause) {
      error = cause.getClass().getSimpleName() + ": " + cause.getMessage();
      Log.e(TAG, "loadLibrary(yieyu_authz) failed: " + error);
    }
    LOADED = loaded;
    LOAD_ERROR = error;
  }

  private final ReactApplicationContext reactContext;
  private final SecureTokenStore tokenStore;
  /** 通用小密钥抽屉（Keystore，不要求指纹）：管理端 Token 之类 */
  private final SecretStore secretStore;
  private final Handler mainHandler = new Handler(Looper.getMainLooper());
  private BroadcastReceiver screenOffReceiver;
  private boolean promptRunning = false;
  private String cachedDeviceCode = "";

  public AuthzModule(ReactApplicationContext context) {
    super(context);
    this.reactContext = context;
    this.tokenStore = new SecureTokenStore(context);
    this.secretStore = new SecretStore(context);
    registerScreenOffReceiver();
  }

  // ------------------------------------------------------------ native (C++)

  private static native String nativeDeviceCode(String seed);
  private static native String nativeEntryKey(String deviceCode);
  private static native String nativeQqKey(String qq);
  private static native String nativeSignText(String text);
  private static native String nativeMigrateExport(String deviceCode, long expMs, long nowSec);
  private static native String nativeMigrateImport(String code, long nowSec);
  private static native String nativeSelfTest();

  // ------------------------------------------------------------ RN 生命周期

  @Override
  public String getName() {
    return NAME;
  }

  @Override
  public void invalidate() {
    unregisterScreenOffReceiver();
    super.invalidate();
  }

  @ReactMethod
  public void addListener(String eventName) {
    // 保持 EventEmitter 契约（JS 侧 addListener 不报错）
  }

  @ReactMethod
  public void removeListeners(double count) {
    // 同上
  }

  // ------------------------------------------------------------ 设备身份

  /** 自检：返回空串表示授权核正常；否则是失败原因（JS 启动时先问这一句） */
  @ReactMethod
  public void selfTest(Promise promise) {
    if (!LOADED) {
      promise.resolve(LOAD_ERROR.length() > 0 ? LOAD_ERROR : "授权核未加载");
      return;
    }
    try {
      final String result = nativeSelfTest();
      promise.resolve(result == null ? "" : result);
    } catch (Throwable error) {
      promise.resolve(message(error));
    }
  }

  /** 设备码：ANDROID_ID + 机型信息 + 包名 → C++ 派生（重装不变号，换机才变） */
  @ReactMethod
  public void getDeviceCode(Promise promise) {
    if (!LOADED) {
      promise.reject("AUTHZ_NATIVE", LOAD_ERROR);
      return;
    }
    try {
      if (cachedDeviceCode.isEmpty()) cachedDeviceCode = nativeDeviceCode(deviceSeed());
      promise.resolve(cachedDeviceCode);
    } catch (Throwable error) {
      promise.reject("AUTHZ_DEVICE_CODE", message(error));
    }
  }

  /** 白名单 / 黑名单条目键：管理端填设备码时用它，客户端比对也是它 */
  @ReactMethod
  public void getEntryKey(String deviceCode, Promise promise) {
    if (!LOADED) {
      promise.reject("AUTHZ_NATIVE", LOAD_ERROR);
      return;
    }
    try {
      promise.resolve(nativeEntryKey(deviceCode == null ? "" : deviceCode));
    } catch (Throwable error) {
      promise.reject("AUTHZ_ENTRY_KEY", message(error));
    }
  }

  /** QQ 的条目键：管理端「按 QQ 封禁」和客户端「被封禁检测」都用同一套算法 */
  @ReactMethod
  public void getQqKey(String qq, Promise promise) {
    if (!LOADED) {
      promise.reject("AUTHZ_NATIVE", LOAD_ERROR);
      return;
    }
    try {
      promise.resolve(nativeQqKey(qq == null ? "" : qq));
    } catch (Throwable error) {
      promise.reject("AUTHZ_QQ_KEY", message(error));
    }
  }

  /** 给一段文本做 HMAC（授权申请码防篡改） */
  @ReactMethod
  public void signText(String text, Promise promise) {
    if (!LOADED) {
      promise.reject("AUTHZ_NATIVE", LOAD_ERROR);
      return;
    }
    try {
      promise.resolve(nativeSignText(text == null ? "" : text));
    } catch (Throwable error) {
      promise.reject("AUTHZ_SIGN", message(error));
    }
  }

  // ------------------------------------------------------------ 指纹与令牌

  /** 指纹可用性：{available, message} */
  @ReactMethod
  public void getBiometricState(Promise promise) {
    final WritableMap state = Arguments.createMap();
    boolean available = false;
    String reason = "";
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      reason = "系统版本过低（需要 Android 6.0+）";
    } else {
      try {
        final BiometricManager manager = BiometricManager.from(reactContext);
        final int result = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        if (result == BiometricManager.BIOMETRIC_SUCCESS) {
          available = true;
        } else if (result == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) {
          reason = "还没录入指纹，请先去系统设置里录入";
        } else if (result == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE) {
          reason = "本机没有可用的指纹硬件";
        } else if (result == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE) {
          reason = "指纹硬件暂时不可用，请稍后重试";
        } else {
          reason = "指纹验证不可用（" + result + "）";
        }
      } catch (Throwable error) {
        reason = message(error);
      }
    }
    state.putBoolean("available", available);
    state.putString("message", reason);
    promise.resolve(state);
  }

  /** 本机是否已有加密授权（不触发指纹） */
/* ------------------------- 通用小密钥（Keystore，不要求指纹） ------------------------- */

  /**
   * 写入一条小密钥（AES-256-GCM，密钥在 Keystore 里永不导出）。
   * 失败时 Promise.reject，JS 侧必须降级成"只放内存"，禁止回落到明文存储。
   */
  @ReactMethod
  public void secretSet(String name, String value, Promise promise) {
    if (name == null || name.length() == 0) {
      promise.reject("AUTHZ_SECRET", "name 不能为空");
      return;
    }
    if (value == null) {
      promise.reject("AUTHZ_SECRET", "value 不能为空");
      return;
    }
    try {
      secretStore.put(name, value);
      promise.resolve(null);
    } catch (Throwable error) {
      promise.reject("AUTHZ_SECRET", message(error));
    }
  }

  /** 读取；没有/解不开都 resolve(null)，由 JS 决定后续（绝不返回明文兜底） */
  @ReactMethod
  public void secretGet(String name, Promise promise) {
    if (name == null || name.length() == 0) {
      promise.reject("AUTHZ_SECRET", "name 不能为空");
      return;
    }
    try {
      promise.resolve(secretStore.get(name));
    } catch (Throwable error) {
      promise.reject("AUTHZ_SECRET", message(error));
    }
  }

  @ReactMethod
  public void secretRemove(String name, Promise promise) {
    if (name == null || name.length() == 0) {
      promise.reject("AUTHZ_SECRET", "name 不能为空");
      return;
    }
    try {
      secretStore.remove(name);
      promise.resolve(null);
    } catch (Throwable error) {
      promise.reject("AUTHZ_SECRET", message(error));
    }
  }

  @ReactMethod
  public void hasToken(Promise promise) {
    try {
      promise.resolve(tokenStore.hasToken());
    } catch (Throwable error) {
      promise.reject("AUTHZ_TOKEN", message(error));
    }
  }

  /** 绑定：先验指纹，再把明文令牌用 Keystore 密钥加密落盘 */
  @ReactMethod
  public void storeToken(String plainToken, Promise promise) {
    if (plainToken == null || plainToken.length() == 0) {
      promise.reject("AUTHZ_TOKEN", "授权数据为空");
      return;
    }
    final Cipher cipher;
    try {
      cipher = tokenStore.beginEncrypt();
    } catch (Throwable error) {
      promise.reject("AUTHZ_KEYSTORE", message(error));
      return;
    }
    final byte[] plain = plainToken.getBytes(UTF8);
    authenticate(new BiometricPrompt.CryptoObject(cipher), "绑定本机授权", "验证指纹后，本机授权将以硬件密钥加密保存",
        new OnAuthSuccess() {
          @Override
          public void onSuccess(Cipher unlocked) {
            try {
              tokenStore.commit(unlocked, plain);
              promise.resolve(null);
            } catch (Throwable error) {
              tokenStore.clear();
              promise.reject("AUTHZ_STORE", message(error));
            }
          }
        },
        new OnAuthFailure() {
          @Override
          public void onFailure(String code, String text) {
            promise.reject(code, text);
          }
        });
  }

  /** 解锁：验指纹 → 解密令牌明文返回（只进内存，JS 不许落盘） */
  @ReactMethod
  public void readToken(Promise promise) {
    final Cipher cipher;
    try {
      cipher = tokenStore.beginDecrypt();
    } catch (KeyPermanentlyInvalidatedException error) {
      tokenStore.clear();
      promise.reject("AUTHZ_REBIND", "本机指纹有变动，请重新绑定授权");
      return;
    } catch (Throwable error) {
      promise.reject("AUTHZ_KEYSTORE", message(error));
      return;
    }
    authenticate(new BiometricPrompt.CryptoObject(cipher), "验证指纹", "解锁本机授权",
        new OnAuthSuccess() {
          @Override
          public void onSuccess(Cipher unlocked) {
            try {
              promise.resolve(tokenStore.finishRead(unlocked));
            } catch (KeyPermanentlyInvalidatedException error) {
              tokenStore.clear();
              promise.reject("AUTHZ_REBIND", "本机指纹有变动，请重新绑定授权");
            } catch (Throwable error) {
              promise.reject("AUTHZ_READ", message(error));
            }
          }
        },
        new OnAuthFailure() {
          @Override
          public void onFailure(String code, String text) {
            promise.reject(code, text);
          }
        });
  }

  /** 解除本机绑定（删密文 + 删密钥） */
  @ReactMethod
  public void clearToken(Promise promise) {
    try {
      tokenStore.clear();
      promise.resolve(null);
    } catch (Throwable error) {
      promise.reject("AUTHZ_CLEAR", message(error));
    }
  }

  // ------------------------------------------------------------ 换机迁移

  /** 老设备导出迁移码（调用方必须先用 readToken 验过指纹） */
  @ReactMethod
  public void exportMigration(double expMs, Promise promise) {
    if (!LOADED) {
      promise.reject("AUTHZ_NATIVE", LOAD_ERROR);
      return;
    }
    try {
      if (cachedDeviceCode.isEmpty()) cachedDeviceCode = nativeDeviceCode(deviceSeed());
      final String code = nativeMigrateExport(cachedDeviceCode, (long) expMs, System.currentTimeMillis() / 1000L);
      if (code != null && code.startsWith("err|")) promise.reject("AUTHZ_MIGRATE", code.substring(4));
      else promise.resolve(code);
    } catch (Throwable error) {
      promise.reject("AUTHZ_MIGRATE", message(error));
    }
  }

  /** 新设备校验迁移码（不弹指纹；JS 拿到结果后再走 storeToken 完成绑定） */
  @ReactMethod
  public void importMigration(String code, Promise promise) {
    if (!LOADED) {
      promise.reject("AUTHZ_NATIVE", LOAD_ERROR);
      return;
    }
    try {
      final String raw = nativeMigrateImport(code == null ? "" : code, System.currentTimeMillis() / 1000L);
      if (raw == null || raw.startsWith("err|")) {
        promise.reject("AUTHZ_MIGRATE", raw == null ? "迁移码无效" : raw.substring(4));
        return;
      }
      final String[] parts = raw.split("\\|");
      if (parts.length < 6) {
        promise.reject("AUTHZ_MIGRATE", "迁移码解析失败");
        return;
      }
      final WritableMap result = Arguments.createMap();
      result.putDouble("expMs", Double.parseDouble(parts[2]));
      result.putDouble("issuedSec", Double.parseDouble(parts[3]));
      result.putString("srcTag", parts[4]);
      result.putDouble("nonce", Double.parseDouble(parts[5]));
      promise.resolve(result);
    } catch (Throwable error) {
      promise.reject("AUTHZ_MIGRATE", message(error));
    }
  }

  // ------------------------------------------------------------ 指纹对话

  private interface OnAuthSuccess {
    void onSuccess(Cipher cipher);
  }

  private interface OnAuthFailure {
    void onFailure(String code, String text);
  }

  private void authenticate(final BiometricPrompt.CryptoObject crypto, final String title, final String subtitle,
                            final OnAuthSuccess success, final OnAuthFailure failure) {
    final Activity current = getCurrentActivity();
    if (!(current instanceof FragmentActivity)) {
      failure.onFailure("AUTHZ_NO_ACTIVITY", "当前界面不支持指纹验证，请回到授权页重试");
      return;
    }
    if (promptRunning) {
      failure.onFailure("AUTHZ_BUSY", "指纹验证正在进行，请先完成上一次验证");
      return;
    }
    promptRunning = true;
    final FragmentActivity activity = (FragmentActivity) current;
    mainHandler.post(new Runnable() {
      @Override
      public void run() {
        try {
          final BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
              new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                  promptRunning = false;
                  final BiometricPrompt.CryptoObject unlocked = result == null ? null : result.getCryptoObject();
                  final Cipher cipher = unlocked == null ? null : unlocked.getCipher();
                  if (cipher == null) {
                    failure.onFailure("AUTHZ_CIPHER", "指纹通过但密钥句柄丢失，请重试");
                    return;
                  }
                  success.onSuccess(cipher);
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence errString) {
                  promptRunning = false;
                  failure.onFailure("AUTHZ_BIOMETRIC", errString == null ? ("指纹验证失败(" + errorCode + ")") : errString.toString());
                }

                @Override
                public void onAuthenticationFailed() {
                  // 单次不匹配：不回 promise，交给系统继续尝试
                  Log.i(TAG, "onAuthenticationFailed");
                }
              });

          final BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
              .setTitle(title)
              .setSubtitle(subtitle)
              .setNegativeButtonText("取消")
              .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
              .setConfirmationRequired(false)
              .build();
          prompt.authenticate(info, crypto);
        } catch (Throwable error) {
          promptRunning = false;
          failure.onFailure("AUTHZ_PROMPT", message(error));
        }
      }
    });
  }

  // ------------------------------------------------------------ 锁屏熔断

  private void registerScreenOffReceiver() {
    if (screenOffReceiver != null) return;
    screenOffReceiver = new BroadcastReceiver() {
      @Override
      public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) return;
        emitScreenOff();
      }
    };
    try {
      final IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
      if (Build.VERSION.SDK_INT >= 33) {
        reactContext.registerReceiver(screenOffReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
      } else {
        reactContext.registerReceiver(screenOffReceiver, filter);
      }
    } catch (Throwable error) {
      Log.w(TAG, "registerReceiver(ACTION_SCREEN_OFF) failed", error);
    }
  }

  private void unregisterScreenOffReceiver() {
    if (screenOffReceiver == null) return;
    try {
      reactContext.unregisterReceiver(screenOffReceiver);
    } catch (Throwable error) {
      Log.w(TAG, "unregisterReceiver failed", error);
    }
    screenOffReceiver = null;
  }

  private void emitScreenOff() {
    try {
      if (!reactContext.hasActiveReactInstance()) return;
      final WritableMap payload = Arguments.createMap();
      payload.putDouble("at", System.currentTimeMillis());
      reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
          .emit(EVENT_SCREEN_OFF, payload);
    } catch (Throwable error) {
      Log.w(TAG, "emit screenOff failed", error);
    }
  }

  // ------------------------------------------------------------ 小工具

  /** 设备身份种子：只用「重装/清数据都不变」的字段 */
  private String deviceSeed() {
    String androidId = null;
    try {
      androidId = Settings.Secure.getString(reactContext.getContentResolver(), Settings.Secure.ANDROID_ID);
    } catch (Throwable error) {
      Log.w(TAG, "read ANDROID_ID failed", error);
    }
    if (androidId == null || androidId.trim().length() < 6) {
      final SharedPreferences pref = reactContext.getSharedPreferences(PREF_DEVICE, Context.MODE_PRIVATE);
      String fallback = pref.getString(FIELD_SEED, null);
      if (fallback == null || fallback.length() < 16) {
        fallback = tokenStore.randomHex(16);
        pref.edit().putString(FIELD_SEED, fallback).commit();
      }
      androidId = fallback;
    }
    return "and|" + reactContext.getPackageName() + "|" + androidId + "|" + Build.MANUFACTURER + "|"
        + Build.MODEL + "|" + Build.DEVICE + "|" + Build.BOARD;
  }

  private static String message(Throwable error) {
    if (error == null) return "未知错误";
    final String text = error.getMessage();
    return text == null || text.length() == 0 ? error.getClass().getSimpleName() : text;
  }
}
