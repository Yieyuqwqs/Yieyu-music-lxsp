package cn.toside.music.mobile.bt;

import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

/**
 * 蓝牙音频状态（只读）+ 打开开发者选项。
 *
 * 红线说明：本模块**不参与任何音频处理**，只读取 AudioManager 的输出设备列表，
 * 用来判断「当前是不是蓝牙耳机在出声」，以及给用户一个跳开发者选项的入口。
 * 不注册 A2DP 广播（避免 Android 12 的 BLUETOOTH_CONNECT 运行时权限），
 * 只用 AudioDeviceCallback —— 无需任何权限。
 */
public final class BtAudioModule extends ReactContextBaseJavaModule {
  private static final String EVENT_NAME = "YieyuBtAudioChanged";

  private final ReactApplicationContext context;
  private final AudioManager audioManager;
  private final AudioDeviceCallback deviceCallback;
  private boolean lastConnected = false;
  private String lastName = "";
  private String lastType = "";

  public BtAudioModule(ReactApplicationContext reactContext) {
    super(reactContext);
    context = reactContext;
    audioManager = (AudioManager) reactContext.getSystemService(Context.AUDIO_SERVICE);
    deviceCallback = new AudioDeviceCallback() {
      @Override
      public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
        refresh();
      }

      @Override
      public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
        refresh();
      }
    };
    if (android.os.Build.VERSION.SDK_INT >= 23) {
      try {
        audioManager.registerAudioDeviceCallback(deviceCallback, new Handler(Looper.getMainLooper()));
      } catch (Throwable ignored) {
        // 极少数机型不允许注册回调，退化为「只在查询时读取」
      }
    }
  }

  @Override
  @NonNull
  public String getName() {
    return "BtAudioModule";
  }

  private static String typeOf(int type) {
    switch (type) {
      case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
        return "a2dp";
      case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
        return "sco";
      default:
        return "";
    }
  }

  /** 读当前蓝牙输出状态：connected / name / type（a2dp | sco | 空） */
  private WritableMap readState() {
    boolean connected = false;
    String name = "";
    String type = "";
    try {
      for (AudioDeviceInfo info : audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
        String t = typeOf(info.getType());
        if (t.isEmpty()) continue;
        connected = true;
        type = t;
        CharSequence productName = info.getProductName();
        name = productName == null ? "" : productName.toString();
        break;
      }
    } catch (Throwable ignored) {
    }
    WritableMap map = Arguments.createMap();
    map.putBoolean("connected", connected);
    map.putString("name", name);
    map.putString("type", type);
    return map;
  }

  private void refresh() {
    WritableMap map = readState();
    boolean connected = map.getBoolean("connected");
    String name = map.getString("name");
    String type = map.getString("type");
    if (connected == lastConnected && (name == null ? "" : name).equals(lastName) && (type == null ? "" : type).equals(lastType)) {
      return;
    }
    lastConnected = connected;
    lastName = name == null ? "" : name;
    lastType = type == null ? "" : type;
    try {
      context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
        .emit(EVENT_NAME, map);
    } catch (Throwable ignored) {
    }
  }

  @ReactMethod
  public void getState(Promise promise) {
    WritableMap map = readState();
    lastConnected = map.getBoolean("connected");
    lastName = map.getString("name") == null ? "" : map.getString("name");
    lastType = map.getString("type") == null ? "" : map.getString("type");
    promise.resolve(map);
  }

  /** 打开「开发者选项」，让用户自己选蓝牙编码器（App 无权限替用户改） */
  @ReactMethod
  public void openDeveloperOptions(Promise promise) {
    boolean ok = false;
    try {
      Intent intent = new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS);
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      context.startActivity(intent);
      ok = true;
    } catch (Throwable ignored) {
    }
    if (!ok) {
      try {
        Intent fallback = new Intent(Settings.ACTION_SETTINGS);
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(fallback);
        ok = true;
      } catch (Throwable ignored) {
      }
    }
    promise.resolve(ok);
  }

  @Override
  public void invalidate() {
    if (android.os.Build.VERSION.SDK_INT >= 23) {
      try {
        audioManager.unregisterAudioDeviceCallback(deviceCallback);
      } catch (Throwable ignored) {
      }
    }
    super.invalidate();
  }
}
