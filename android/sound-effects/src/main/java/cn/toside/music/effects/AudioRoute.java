package cn.toside.music.effects;

import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

/** 是否接了耳机：外放时做双耳渲染没有意义，直接旁路。 */
final class AudioRoute {
    private static volatile boolean headset;
    private static AudioManager manager;
    private static AudioDeviceCallback callback;
    private static boolean registered;

    private AudioRoute() {}

    static boolean isHeadset() {
        return headset;
    }

    static synchronized void start(Context context) {
        if (manager == null && context != null) {
            manager = (AudioManager) context.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
        }
        refresh();
        if (!registered && manager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            callback = new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                    refresh();
                }

                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                    refresh();
                }
            };
            manager.registerAudioDeviceCallback(callback, new Handler(Looper.getMainLooper()));
            registered = true;
        }
    }

    static void refresh() {
        AudioManager current = manager;
        if (current == null) return;
        boolean found = false;
        try {
            AudioDeviceInfo[] devices = current.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
            for (int i = 0; i < devices.length && !found; i++) {
                switch (devices[i].getType()) {
                    case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                    case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                    case AudioDeviceInfo.TYPE_USB_HEADSET:
                    case AudioDeviceInfo.TYPE_USB_DEVICE:
                    case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                    case AudioDeviceInfo.TYPE_HEARING_AID:
                    case 26: // TYPE_BLE_HEADSET (API 31)
                    case 27: // TYPE_BLE_SPEAKER (API 31)
                        found = true;
                        break;
                    default:
                        break;
                }
            }
        } catch (Throwable ignored) {
            return;
        }
        headset = found;
    }
}
