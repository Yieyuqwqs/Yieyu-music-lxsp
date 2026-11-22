package cn.toside.music.effects;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

/**
 * 重低音震动（第二版）：
 * - 只取 20~60Hz 的打击点（一阶高通 20Hz + 一阶低通 60Hz 串联），中低频不再乱震
 * - 强度是单调映射：UI 10% → 很轻的点触，100% → 才有明显震感
 * - 最长 11Hz 一次、单次 20~40ms，不再像来电马达
 */
public final class HapticBass {
    private static final double LOWPASS_HZ = 60d;
    private static final double HIGHPASS_HZ = 20d;
    private static final int WINDOW_FRAMES = 441;
    private static final long MIN_GAP_MS = 110L;

    private static volatile boolean enabled;
    private static volatile float strength = 0.6f;
    private static volatile Vibrator vibrator;
    private static volatile boolean amplitudeSupported;

    private static HandlerThread thread;
    private static Handler handler;

    private static double lpState;
    private static double hpPrevIn;
    private static double hpPrevOut;
    private static double lpCoef = 0.01;
    private static double hpCoef = 0.99;
    private static double accSum;
    private static int accCount;
    private static float smoothed;
    private static long lastPulseAt;
    private static double baseline = 0.01d;
    private static double prevRms;
    private static long lastOnsetAt;
    private static long lastRate = -1L;
    private static long pulses;
    private static long lastDiagAt;

    private HapticBass() {
    }

    public static synchronized void configure(Context context, boolean enable, float level) {
        enabled = enable;
        float value = level <= 0f ? 0f : (level > 1f ? 1f : level);
        strength = value;
        if (context == null) return;
        Context app = context.getApplicationContext();
        if (enable) {
            ensureVibrator(app);
            ensureThread();
            accSum = 0d;
            accCount = 0;
            smoothed = 0f;
            lastPulseAt = 0;
        } else {
            cancel();
        }
    }

    public static boolean isEnabled() {
        return enabled;
    }

    public static float strength() {
        return strength;
    }

    public static boolean amplitudeSupported() {
        return amplitudeSupported;
    }

    public static boolean deviceReady() {
        return vibrator != null;
    }

    private static synchronized void ensureVibrator(Context context) {
        if (vibrator != null) return;
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                Object manager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (manager instanceof VibratorManager) vibrator = ((VibratorManager) manager).getDefaultVibrator();
            }
            if (vibrator == null) {
                Object service = context.getSystemService(Context.VIBRATOR_SERVICE);
                if (service instanceof Vibrator) vibrator = (Vibrator) service;
            }
            if (vibrator != null) amplitudeSupported = Build.VERSION.SDK_INT >= 26 && vibrator.hasAmplitudeControl();
        } catch (Throwable error) {
            vibrator = null;
        }
    }

    private static synchronized void ensureThread() {
        if (handler != null) return;
        thread = new HandlerThread("lx-haptic-bass");
        thread.setDaemon(true);
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    public static synchronized void cancel() {
        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Throwable ignored) {
        }
    }

    /** 音频线程：两级一阶滤波 + 平方累加，无分配无锁 */
    static void feed(float[][] input, int channels, int frames) {
        if (!enabled || frames <= 0 || input.length < 1) return;
        long rate = SoundEffects.lastRate();
        if (rate != lastRate) {
            lastRate = rate;
            double sr = Math.max(8000d, (double) rate);
            lpCoef = 1d - Math.exp(-2d * Math.PI * LOWPASS_HZ / sr);
            hpCoef = 1d / (1d + 2d * Math.PI * HIGHPASS_HZ / sr);
        }
        float[] left = input[0];
        float[] right = channels > 1 && input.length > 1 ? input[1] : null;
        double sum = 0d;
        double lp = lpState;
        double prevIn = hpPrevIn;
        double prevOut = hpPrevOut;
        for (int i = 0; i < frames; i++) {
            double sample = right == null ? left[i] : (left[i] + right[i]) * 0.5d;
            double hp = hpCoef * (prevOut + sample - prevIn);
            prevIn = sample;
            prevOut = hp;
            lp += (hp - lp) * lpCoef;
            sum += lp * lp;
        }
        lpState = lp;
        hpPrevIn = prevIn;
        hpPrevOut = prevOut;
        accSum += sum;
        accCount += frames;
        if (accCount < WINDOW_FRAMES) return;
        double rms = Math.sqrt(accSum / accCount);
        accSum = 0d;
        accCount = 0;
        onEnergy((float) rms);
    }

    /**
     * 起音检测（onset detection）：能量突然「跳上来」才算一下鼓
     * - baseline 是 ~0.8s 的滑动底噪，长音/贝斯持续音只会抬 baseline，不触发
     * - 必须同时满足「能量比底噪高 2.2 倍」且「这一窗比上一窗还在涨」才算瞬态
     * - 110ms 不应期：再密的鼓也不会连成马达
     */
    private static void onEnergy(float rms) {
        double energy = rms;
        baseline = baseline + (energy - baseline) * 0.012d;
        if (baseline < 0.002d) baseline = 0.002d;
        double flux = energy - prevRms;
        prevRms = energy;
        double ratio = energy / baseline;
        long now = SystemClock.elapsedRealtime();
        boolean hit = ratio > 2.2d && flux > baseline * 0.8d;
        if (!hit) {
            smoothed *= 0.55f;
            return;
        }
        if (now - lastOnsetAt < MIN_GAP_MS) return;
        if (now - lastPulseAt < MIN_GAP_MS) return;
        lastOnsetAt = now;
        lastPulseAt = now;
        float power = (float) Math.min(1d, (ratio - 1.8d) / 6d);
        smoothed = smoothed * 0.3f + (0.35f + 0.65f * power) * 0.7f;
        double shaped = Math.pow(smoothed, 1.4d);
        double scaled = Math.pow(strength, 1.3d);
        int amplitude = (int) Math.round(255d * scaled * shaped);
        if (amplitude < 4) return;
        if (amplitude > 255) amplitude = 255;
        int duration = (int) Math.round(20d + 20d * strength);
        final int value = amplitude;
        final int length = duration;
        Handler target = handler;
        if (target == null) return;
        target.post(() -> pulse(value, length));
    }

    private static void pulse(int amplitude, int duration) {
        Vibrator device = vibrator;
        if (device == null || !enabled) return;
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                VibrationEffect effect = amplitudeSupported
                    ? VibrationEffect.createOneShot(duration, amplitude)
                    : VibrationEffect.createWaveform(new long[] { 0, duration }, -1);
                device.vibrate(effect);
            } else {
                device.vibrate(duration);
            }
            pulses++;
            long now = SystemClock.elapsedRealtime();
            if (now - lastDiagAt > 3000L) {
                lastDiagAt = now;
                SoundEffects.diag("HAPTIC pulses=" + pulses + " amp=" + amplitude + " len=" + duration +
                    " strength=" + strength + " ampControl=" + amplitudeSupported);
            }
        } catch (Throwable ignored) {
        }
    }
}
