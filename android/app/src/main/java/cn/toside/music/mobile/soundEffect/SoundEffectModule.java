package cn.toside.music.mobile.soundEffect;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import cn.toside.music.effects.EffectSettings;
import cn.toside.music.effects.Eq31;
import cn.toside.music.effects.HiRes;
import cn.toside.music.effects.HapticBass;
import cn.toside.music.effects.SoundEffects;
import cn.toside.music.effects.Vinyl;
import cn.toside.music.effects.VisualizerTap;

public final class SoundEffectModule extends ReactContextBaseJavaModule {
    public SoundEffectModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "SoundEffectModule";
    }

    /** 自检：音频线程到底处理了多少帧、当前生效的模式，用来排查音效是否真的跑起来 */
    @ReactMethod
    public void getStats(Promise promise) {
        try {
            WritableMap map = Arguments.createMap();
            map.putDouble("frames", SoundEffects.processedFrames());
            map.putInt("channels", SoundEffects.lastChannels());
            map.putInt("rate", SoundEffects.lastRate());
            map.putInt("mode", SoundEffects.lastMode());
            map.putDouble("strength", SoundEffects.lastStrength());
            map.putBoolean("prepared", SoundEffects.hasPrepared());
            map.putBoolean("headTrackReady", SoundEffects.headTrackReady());
            map.putBoolean("headTrackLoaded", SoundEffects.headTrackLoaded());
            map.putString("headTrackBackend", SoundEffects.headTrackBackend());
            map.putString("headTrackError", SoundEffects.headTrackError());
            map.putBoolean("headset", SoundEffects.headset());
            map.putDouble("headTrackYaw", SoundEffects.headTrackYaw());
            map.putDouble("headTrackPredict", SoundEffects.headTrackPredict());
            map.putBoolean("hiresSupported", HiRes.available());
            map.putBoolean("hiresEnabled", HiRes.enabled());
            map.putInt("hiresTarget", HiRes.target());
            map.putInt("hiresOutputRate", HiRes.activeOutputRate());
            map.putInt("hiresInputRate", HiRes.activeInputRate());
            map.putDouble("hiresFrames", HiRes.renderedFrames());
            map.putString("hiresError", HiRes.loadError());
            // Aurora-15 冷链防抖：降级链 / 冷链冷却的真实状态，UI 必须按它诚实显示
            map.putInt("hiresEffectiveTarget", HiRes.effectiveTarget());
            map.putBoolean("hiresDegraded", HiRes.degraded());
            map.putInt("hiresDegrades", HiRes.degradeCount());
            map.putString("hiresDegradeReason", HiRes.lastDegradeReason());
            map.putDouble("hiresCooldownMs", HiRes.cooldownRemainingMs());
            // Aurora-27：31 段均衡器内核状态（给面板诚实显示"是不是 C++ 在跑"）
            map.putBoolean("eq31Available", Eq31.available());
            map.putBoolean("eqNative", SoundEffects.eqNative());
            map.putInt("eqBands", SoundEffects.eqBands());
            map.putDouble("eqTrimDb", SoundEffects.eqTrimDb());
            map.putInt("eqLiveBands", SoundEffects.eqLiveBands());
            // Aurora-29：模拟黑胶 / 胆机模块
            map.putBoolean("vinylAvailable", Vinyl.available());
            map.putBoolean("vinylNative", SoundEffects.vinylNative());
            map.putDouble("vinylAmount", SoundEffects.vinylAmount());
            map.putInt("vinylOs", SoundEffects.vinylOs());
            map.putDouble("vinylDriveDb", SoundEffects.vinylDriveDb());
            map.putDouble("vinylHissDb", SoundEffects.vinylHissDb());
            promise.resolve(map);
        } catch (Exception error) {
            promise.reject("sound_effect_stats_failed", error);
        }
    }

    /** 可视化：返回按屏幕宽度自适应好的柱高数组（0..255） */
    @ReactMethod
    public void getVisualizer(int count, Promise promise) {
        try {
            int[] bands = VisualizerTap.analyze(count, SoundEffects.lastRate());
            WritableArray array = Arguments.createArray();
            for (int value : bands) array.pushInt(value);
            WritableMap map = Arguments.createMap();
            map.putArray("bands", array);
            map.putBoolean("active", VisualizerTap.isFresh());
            map.putDouble("rms", VisualizerTap.lastRms());
            promise.resolve(map);
        } catch (Exception error) {
            promise.reject("sound_effect_visualizer_failed", error);
        }
    }

    /** 没人看可视化时让音频线程连拷贝都省掉 */
    @ReactMethod
    public void setVisualizerEnabled(boolean enabled) {
        VisualizerTap.setEnabled(enabled);
    }

    private static boolean lastHapticEnabled;

    /** 重低音震动：开关 + 强度（0..1），只写静态标志，音频线程下一块就生效 */
    @ReactMethod
    public void setHapticBass(boolean enable, double strength) {
        try {
            boolean changed = enable != lastHapticEnabled;
            lastHapticEnabled = enable;
            HapticBass.configure(getReactApplicationContext(), enable, (float) strength);
            // 只有开关真的变了才重算 offload：频繁切换会重建 AudioTrack，是「暂停恢复后无声」的诱因
            if (changed) SoundEffects.refreshOffload();
        } catch (Throwable ignored) {
        }
    }

    /**
     * 极客功能一：本地插值升频开关 + 目标采样率（192000/96000/48000）。
     * 采样率变了要让 AudioSink 重新 configure，所以改完立刻重建一次管线。
     */
    @ReactMethod
    public void setHiRes(boolean enable, int targetRate) {
        try {
            boolean changed = enable != HiRes.enabled() || targetRate != HiRes.target();
            HiRes.setConfig(enable, targetRate);
            if (!enable) HiRes.clearStats();
            if (changed) SoundEffects.rebuildSink();
        } catch (Throwable ignored) {
        }
    }

    @ReactMethod
    public void getHapticBass(Promise promise) {
        try {
            WritableMap map = Arguments.createMap();
            map.putBoolean("enabled", HapticBass.isEnabled());
            map.putDouble("strength", HapticBass.strength());
            map.putBoolean("amplitude", HapticBass.amplitudeSupported());
            map.putBoolean("ready", HapticBass.deviceReady());
            promise.resolve(map);
        } catch (Exception error) {
            promise.reject("haptic_bass_failed", error);
        }
    }

    @ReactMethod
    public void configure(ReadableMap options, Promise promise) {
        try {
            ReadableArray bands = options.getArray("gains");
            if (bands == null || bands.size() != EffectSettings.FREQUENCIES.length) {
                throw new IllegalArgumentException("Invalid equalizer bands");
            }
            double[] gains = new double[bands.size()];
            for (int i = 0; i < gains.length; i++) gains[i] = bands.getDouble(i);
            // Aurora-27：31 段（三分之一倍频程）增益。缺省全 0，长度不对就按全平处理，不让脏数据进原生层
            double[] gains31 = new double[EffectSettings.FREQUENCIES_31.length];
            ReadableArray bands31 = options.hasKey("gains31") ? options.getArray("gains31") : null;
            if (bands31 != null && bands31.size() == gains31.length) {
                for (int i = 0; i < gains31.length; i++) gains31[i] = bands31.getDouble(i);
            }
            int eqMode = options.hasKey("eqMode") ? options.getInt("eqMode") : EffectSettings.MODE_TEN;
            boolean eqHeadroom = !options.hasKey("eqHeadroom") || options.getBoolean("eqHeadroom");
            String source = options.getString("source");
            int surroundMode = options.hasKey("surroundMode") ? options.getInt("surroundMode") : 0;
            double surroundStrength = options.hasKey("surroundStrength") ? options.getDouble("surroundStrength") : 0;
            double surroundSpeed = options.hasKey("surroundSpeed") ? options.getDouble("surroundSpeed") : 0.12;
            boolean headTrack = options.hasKey("headTrack") && options.getBoolean("headTrack");
            // Aurora-29：味精加量。缺省 0（直通），越界夹紧，NaN 也一并挡住
            double vinylAmount = options.hasKey("vinylAmount") ? options.getDouble("vinylAmount") : 0;
            if (Double.isNaN(vinylAmount) || vinylAmount < 0) vinylAmount = 0;
            if (vinylAmount > 1) vinylAmount = 1;
            boolean vinylTube = !options.hasKey("vinylTube") || options.getBoolean("vinylTube");
            boolean vinylNoise = !options.hasKey("vinylNoise") || options.getBoolean("vinylNoise");
            boolean vinylWow = !options.hasKey("vinylWow") || options.getBoolean("vinylWow");
            boolean vinylHiFi = !options.hasKey("vinylHiFi") || options.getBoolean("vinylHiFi");
            boolean vinylLpf = !options.hasKey("vinylLpf") || options.getBoolean("vinylLpf");
            EffectSettings settings = new EffectSettings(options.getBoolean("equalizer"), gains,
                source == null ? "" : source, options.getDouble("dry"), options.getDouble("wet"),
                surroundMode, surroundStrength, surroundSpeed, headTrack,
                eqMode, gains31, eqHeadroom,
                vinylAmount, vinylTube, vinylNoise, vinylWow, vinylHiFi, vinylLpf);
            SoundEffects.configure(getReactApplicationContext(), settings, error -> {
                if (error == null) promise.resolve(null);
                else promise.reject("sound_effect_prepare_failed", error);
            });
        } catch (Exception error) {
            promise.reject("sound_effect_invalid_settings", error);
        }
    }
}
