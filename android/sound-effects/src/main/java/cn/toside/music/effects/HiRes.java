package cn.toside.music.effects;

import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.SystemClock;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * 极客功能一：本地插值升频（Hi-Res）的原生壳 + Aurora-15「冷链防抖」状态机。
 *
 * 重采样本身用 C++ 多相 sinc 实现（hires_jni.cpp），这里负责三件事：
 * 1) 探测设备真实能开的输出采样率，并按目标采样率拿到该档的硬缓冲计划；
 * 2) 静默降级链 192 → 96 → 48 → 直通：重采样抛异常 / 超时 / 创建失败时**绝不弹错**，
 *    在后台把档位往下走一档，然后异步重建音频管线；
 * 3) 冷链冷却：每次降级后硬性等 3 秒确认稳住，且任意两次降级至少间隔 1 秒。
 *    这 3 秒内看门狗（AudioRecovery）被静默，避免它把「正在切采样率」误判成管线卡死再踹一脚。
 */
public final class HiRes {
    private static final boolean LOADED;
    private static final String LOAD_ERROR;

    static {
        boolean loaded = false;
        String error = "";
        try {
            System.loadLibrary("yieyu_hrtf");
            loaded = true;
        } catch (Throwable throwable) {
            error = throwable.getClass().getSimpleName() + ": " + throwable.getMessage();
        }
        LOADED = loaded;
        LOAD_ERROR = error;
    }

    public static final int[] TARGETS = {192000, 96000, 48000};

    /** 降级链：192 → 96 → 48 → 0（0 = 升频彻底退出，走原始采样率直通） */
    private static final int[] CHAIN = {192000, 96000, 48000, 0};
    /** 冷链冷却：降级后必须硬等这么久确认稳住 */
    static final long COOLDOWN_MS = 3000L;
    /** 任意两次降级的最小间隔：绝对不允许 1 秒内连续降级 */
    static final long MIN_INTERVAL_MS = 1000L;
    /** 切换保护：重建管线最多等这么久，超时就放行直通，避免把声音永久憋死 */
    private static final long SWITCH_GUARD_MS = 4000L;

    private static volatile boolean enabled = false;
    private static volatile int target = 192000;
    private static volatile int effective = 192000;      // 运行时实际允许的最高输出率
    private static volatile int activeOutputRate = 0;    // 真正跑在 AudioSink 上的输出率
    private static volatile int activeInputRate = 0;     // 解码源采样率
    private static volatile long renderedFrames = 0;
    private static volatile int probedTarget = 0;
    private static volatile int probedRate = 0;

    // 冷链状态
    private static volatile int degradeCount = 0;
    private static volatile long lastDegradeAt = 0;      // elapsedRealtime
    private static volatile long cooldownUntil = 0;      // elapsedRealtime
    private static volatile String lastDegradeReason = "";
    private static volatile boolean pendingDegrade = false;   // 冷却期里又抖了，等冷却结束再降
    private static volatile boolean switching = false;        // 正在切采样率（重建管线）
    private static volatile long switchingUntil = 0;
    private static ScheduledFuture<?> stabilityTask;

    private static final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "lx-hires-coldchain");
        thread.setDaemon(true);
        return thread;
    });

    private HiRes() {}

    public static boolean available() {
        return LOADED;
    }

    public static String loadError() {
        return LOAD_ERROR;
    }

    public static void setConfig(boolean enable, int targetRate) {
        final boolean validRate = targetRate == 192000 || targetRate == 96000 || targetRate == 48000;
        final boolean rateChanged = validRate && targetRate != target;
        enabled = enable;
        if (validRate) target = targetRate;
        // 用户重新选了档位 / 重新开启：清空降级状态，从最高档重新试一次
        if (!enable || rateChanged) resetChain();
    }

    public static boolean enabled() {
        return enabled && LOADED;
    }

    public static int target() {
        return target;
    }

    /**
     * 当前生效的最高档位（降级链走下来后的值）。
     * 0 = 升频已彻底退出，按源采样率直通；注意绝不能在这里把 0 回退成 target，
     * 否则降到底之后再抖一次会「反弹」回 96kHz，形成降级/升档死循环。
     */
    public static int effectiveTarget() {
        return effective;
    }

    public static int activeOutputRate() {
        return activeOutputRate;
    }

    public static int activeInputRate() {
        return activeInputRate;
    }

    public static long renderedFrames() {
        return renderedFrames;
    }

    /**
     * 诚实反馈用：设备实际跑的采样率或降级链已经把档位压下来了，都算「已降级」。
     */
    public static boolean degraded() {
        if (!enabled) return false;
        if (effective < target) return true;   // 含 effective == 0（已退到直通）
        final int output = activeOutputRate;
        return output > 0 && output < target;  // 设备开不出目标档，也算降级
    }

    public static int degradeCount() {
        return degradeCount;
    }

    public static String lastDegradeReason() {
        return lastDegradeReason;
    }

    public static long cooldownRemainingMs() {
        final long until = cooldownUntil;
        final long left = until - SystemClock.elapsedRealtime();
        return left > 0 ? left : 0;
    }

    /** 看门狗静默窗口：降级后的 3 秒内 AudioRecovery 不许判定卡死 */
    static boolean inCooldown() {
        final long until = cooldownUntil;
        return until != 0 && SystemClock.elapsedRealtime() < until;
    }

    /** 正在切采样率（管线重建中）：此期间输出静音，避免采样率错配的怪声 */
    static boolean switchingPending() {
        if (!switching) return false;
        final long until = switchingUntil;
        if (until != 0 && SystemClock.elapsedRealtime() >= until) {
            switching = false;   // 兜底放行：重建没成功也不能把声音永久憋死
            return false;
        }
        return true;
    }

    /** 探测该设备在给定输出采样率上能否真的开出一条 AudioTrack（缓存结果） */
    private static synchronized int probe(int rate) {
        if (probedTarget == rate) return probedRate;
        int best = 0;
        final int[] candidates = rate >= 192000 ? new int[] {192000, 96000, 48000}
            : rate >= 96000 ? new int[] {96000, 48000}
            : new int[] {48000};
        for (int candidate : candidates) {
            if (candidate < rate) continue;
            if (supports(candidate)) {
                best = candidate;
                break;
            }
        }
        probedTarget = rate;
        probedRate = best;
        return best;
    }

    private static boolean supports(int rate) {
        final int minBuffer = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_STEREO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuffer <= 0) return false;
        AudioTrack track = null;
        try {
            track = new AudioTrack(AudioManager.STREAM_MUSIC, rate, AudioFormat.CHANNEL_OUT_STEREO,
                AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuffer * 2, 4096), AudioTrack.MODE_STREAM);
            return track.getState() == AudioTrack.STATE_INITIALIZED;
        } catch (Throwable ignored) {
            return false;
        } finally {
            if (track != null) {
                try { track.release(); } catch (Throwable ignored) {}
            }
        }
    }

    /**
     * 按当前档位建重采样器；建不出来就顺着降级链往下走（同一轮 configure 只算一次降级事件）。
     * 返回 0 表示只能直通（已就地记好降级状态），调用方不许抛异常。
     */
    static long beginResample(int inputRate, int channels) {
        if (!enabled || !LOADED || inputRate <= 0 || channels < 1) return 0;
        final int start = effectiveTarget();
        int ceiling = start;
        int guard = 0;
        long handle = 0;
        int usedRate = 0;
        while (ceiling > inputRate && guard++ < CHAIN.length) {
            final int rate = probe(ceiling);
            if (rate > inputRate) {
                handle = create(inputRate, rate, channels);
                if (handle != 0) {
                    usedRate = rate;
                    break;
                }
                SoundEffects.noteError("hires create failed at " + rate + "Hz");
            } else {
                SoundEffects.noteError("hires device rejects " + ceiling + "Hz");
            }
            ceiling = nextRate(ceiling);
        }
        if (handle != 0) {
            if (usedRate < start) noteChainFallback(start, usedRate, "configure");
            return handle;
        }
        if (ceiling < start) noteChainFallback(start, ceiling, "configure");
        notePassthrough(inputRate);
        return 0;
    }

    /** configure 完成：结束「正在切换采样率」的静音保护 */
    static void noteConfigured() {
        switching = false;
        switchingUntil = 0;
    }

    /** 直通（不升频）时也让 UI 看到真实运行采样率，而不是显示 0 */
    static void notePassthrough(int inputRate) {
        if (inputRate > 0) {
            activeInputRate = inputRate;
            activeOutputRate = inputRate;
        }
        noteConfigured();
    }

    static long create(int inputRate, int outputRate, int channels) {
        if (!LOADED) return 0;
        try {
            final long handle = nativeCreate(inputRate, outputRate, channels);
            if (handle != 0) {
                activeInputRate = inputRate;
                activeOutputRate = outputRate;
            }
            return handle;
        } catch (Throwable ignored) {
            return 0;
        }
    }

    static int capacity(long handle, int frames) {
        try {
            return nativeCapacity(handle, frames);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    /** 该档位的硬缓冲时长（毫秒） */
    static int bufferMs(long handle) {
        try {
            return nativeBufferMs(handle);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    /** 该档位缓冲计划覆盖的输入帧数（Java 预分配用） */
    static int planFrames(long handle) {
        try {
            return nativePlanFrames(handle);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    static int render(long handle, short[] input, int frames, short[] output) {
        return nativeRender(handle, input, frames, output);
    }

    static void reset(long handle) {
        try {
            nativeReset(handle);
        } catch (Throwable ignored) {}
    }

    static void destroy(long handle) {
        try {
            nativeDestroy(handle);
        } catch (Throwable ignored) {}
        activeOutputRate = 0;
    }

    static void record(int frames) {
        renderedFrames += frames;
    }

    /** 关闭升频时把统计重置，界面上才好区分"没生效"和"没数据" */
    public static void clearStats() {
        activeInputRate = 0;
        activeOutputRate = 0;
        renderedFrames = 0;
    }

    // ---------------------------------------------------------------- 冷链防抖

    /**
     * 运行时降级入口（音频线程调用，必须轻量、幂等、绝不抛异常）：
     * 1 秒内第二次降级直接拒绝；3 秒冷链冷却期内只登记待降级，冷却结束再走。
     */
    static synchronized void requestDegrade(String reason) {
        if (!enabled || !LOADED) return;
        final long now = SystemClock.elapsedRealtime();
        if (lastDegradeAt != 0 && now - lastDegradeAt < MIN_INTERVAL_MS) {
            SoundEffects.diag("HIRES_DEGRADE_SKIP reason=" + reason + " since=" + (now - lastDegradeAt)
                + "ms<" + MIN_INTERVAL_MS + "ms");
            return;
        }
        if (now < cooldownUntil) {
            pendingDegrade = true;
            SoundEffects.diag("HIRES_DEGRADE_DEFER reason=" + reason + " left=" + (cooldownUntil - now) + "ms");
            return;
        }
        stepDown(reason);
    }

    /** 真正降一档：开冷却、静默看门狗、后台重建管线 */
    private static void stepDown(String reason) {
        final int current = effectiveTarget();
        final int next = nextRate(current);
        if (next == current) return;   // 已经到底（直通），再降也没得降
        effective = next;
        degradeCount++;
        lastDegradeAt = SystemClock.elapsedRealtime();
        cooldownUntil = lastDegradeAt + COOLDOWN_MS;
        lastDegradeReason = reason;
        pendingDegrade = false;
        switching = true;
        switchingUntil = lastDegradeAt + SWITCH_GUARD_MS;
        SoundEffects.diag("HIRES_DEGRADE " + current + "->" + next + " reason=" + reason
            + " cooldown=" + COOLDOWN_MS + "ms watchdog=muted");
        scheduleStabilityCheck();
        // 绝不在音频线程动 AudioSink：只投递一次重建
        SoundEffects.rebuildSink();
    }

    /** configure 阶段的链路回退：这里不能触发重建（管线正在配置），只记冷却 */
    private static void noteChainFallback(int start, int end, String reason) {
        final int clamped = end > 0 ? end : 0;
        effective = clamped;
        degradeCount++;
        lastDegradeAt = SystemClock.elapsedRealtime();
        cooldownUntil = lastDegradeAt + COOLDOWN_MS;
        lastDegradeReason = reason;
        pendingDegrade = false;
        switching = false;
        switchingUntil = 0;
        SoundEffects.diag("HIRES_CHAIN_FALLBACK " + start + "->" + clamped
            + " reason=" + reason + " cooldown=" + COOLDOWN_MS + "ms watchdog=muted");
        scheduleStabilityCheck();
    }

    private static void scheduleStabilityCheck() {
        if (stabilityTask != null) stabilityTask.cancel(false);
        try {
            stabilityTask = scheduler.schedule(HiRes::onCooldownFinished, COOLDOWN_MS, TimeUnit.MILLISECONDS);
        } catch (Throwable error) {
            SoundEffects.noteError("hires cooldown: " + error);
        }
    }

    /** 冷却 3 秒到点：稳住就放行，还在抖就走下一档 */
    private static synchronized void onCooldownFinished() {
        stabilityTask = null;
        cooldownUntil = 0;
        if (!pendingDegrade) {
            SoundEffects.diag("HIRES_STABLE rate=" + effectiveTarget()
                + " out=" + activeOutputRate + " after=" + COOLDOWN_MS + "ms");
            return;
        }
        // 此时距上次降级已经过了整个冷却窗口（>1s），满足「1 秒内绝不连续降级」
        pendingDegrade = false;
        stepDown("cooldown-unstable");
    }

    private static void resetChain() {
        effective = target;
        degradeCount = 0;
        lastDegradeAt = 0;
        cooldownUntil = 0;
        lastDegradeReason = "";
        pendingDegrade = false;
        switching = false;
        switchingUntil = 0;
        if (stabilityTask != null) {
            stabilityTask.cancel(false);
            stabilityTask = null;
        }
    }

    private static int nextRate(int rate) {
        for (int i = 0; i < CHAIN.length; i++) {
            if (CHAIN[i] == rate) return i + 1 < CHAIN.length ? CHAIN[i + 1] : rate;
        }
        // 不在链上（例如设备只支持 48k）：直接落到直通
        return rate > 48000 ? 48000 : 0;
    }

    private static native long nativeCreate(int inputRate, int outputRate, int channels);
    private static native int nativeCapacity(long handle, int frames);
    private static native int nativeBufferMs(long handle);
    private static native int nativePlanFrames(long handle);
    private static native int nativeRender(long handle, short[] input, int frames, short[] output);
    private static native void nativeReset(long handle);
    private static native void nativeDestroy(long handle);
}
