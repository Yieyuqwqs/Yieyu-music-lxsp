package cn.toside.music.effects;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 音频管线看门狗：每 2 秒确认一次「播放器在播 + PCM 帧在涨」。
 * 不涨就交给 SoundEffects.recoverCheck() 分级重建（seek → stop/prepare/play）。
 *
 * Aurora-15：Hi-Res 降级/切采样率后的 3 秒冷链冷却期内，本看门狗必须静默
 * （HiRes.inCooldown() 为 true 时直接跳过检测），否则会把「正在重建 AudioSink」
 * 误判成「管线卡死」，再踹一脚 stop/prepare，直接雪崩闪退。
 */
final class AudioRecovery {
    private static final long PERIOD_SECONDS = 2;
    private static ScheduledExecutorService timer;

    private AudioRecovery() {}

    static synchronized void start() {
        if (timer != null) return;
        timer = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "lx-audio-recovery");
            thread.setDaemon(true);
            return thread;
        });
        timer.scheduleWithFixedDelay(() -> {
            try {
                // 冷链冷却窗口内直接跳过：这时 processedFrames 停住是预期行为
                if (HiRes.inCooldown()) return;
                SoundEffects.recoverCheck();
            } catch (Throwable error) {
                SoundEffects.noteError("watchdog " + error);
            }
        }, PERIOD_SECONDS, PERIOD_SECONDS, TimeUnit.SECONDS);
    }

    static synchronized void stop() {
        if (timer == null) return;
        timer.shutdownNow();
        timer = null;
    }
}
