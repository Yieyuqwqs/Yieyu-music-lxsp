package cn.toside.music.effects;

import android.content.Context;
import android.os.Handler;
import android.os.SystemClock;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.exoplayer.ExoPlayer;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.io.File;
import java.io.FileWriter;
import java.util.concurrent.atomic.AtomicLong;
import pl.edu.icm.jlargearrays.ConcurrencyUtils;

public final class SoundEffects {
    public interface Completion {
        void complete(Exception error);
    }

    static final class Prepared {
        final String source;
        final int rate;
        final PartitionedConvolver engine;

        Prepared(String source, int rate, PartitionedConvolver engine) {
            this.source = source;
            this.rate = rate;
            this.engine = engine;
        }
    }

    static void runOnWorker(Runnable task) {
        worker.execute(task);
    }

    private static final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "lx-sound-effects");
        thread.setDaemon(true);
        return thread;
    });
    private static final AtomicLong revision = new AtomicLong();
    private static final AtomicLong processedFrames = new AtomicLong();
    private static volatile int lastChannels;
    private static volatile int lastRate;
    private static volatile int lastMode;
    private static volatile float lastStrength;
    private static volatile long lastRunDiagAt;
    private static volatile long lastErrorAt;
    private static long checkFrames = -1;
    private static long checkAt;
    private static int stalledChecks;
    private static int recoverAttempts;
    private static volatile long surroundAppliedBlocks;
    // Aurora-27：31 段均衡器内核的运行时状态（音频线程低频更新，只写这几个 volatile）
    private static volatile boolean eqNative;
    private static volatile int eqBands;
    private static volatile float eqTrimDb;
    private static volatile int eqLiveBands;
    // Aurora-29：模拟黑胶 / 胆机模块的运行时状态
    private static volatile boolean vinylNative;
    private static volatile float vinylAmount;
    private static volatile int vinylOs;
    private static volatile float vinylDriveDb;
    private static volatile float vinylHissDb;
    private static volatile EffectSettings settings = EffectSettings.OFF;
    private static volatile Context appContext;
    private static volatile Prepared prepared;
    private static volatile int sampleRate = 48000;
    private static WeakReference<ExoPlayer> player = new WeakReference<>(null);
    private static boolean allowOffload = true;
    private static volatile boolean forceStream;
    private static WaveImpulse cachedImpulse;
    private static String cachedSource = "";

    private SoundEffects() {}

    private static final java.util.concurrent.LinkedBlockingQueue<String> diagQueue =
        new java.util.concurrent.LinkedBlockingQueue<>(64);

    static {
        Thread thread = new Thread(() -> {
            while (true) {
                String line;
                try {
                    line = diagQueue.take();
                } catch (InterruptedException stop) {
                    return;
                }
                writeDiag(line);
            }
        }, "lx-sfx-diag");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * 诊断行只入队，实际的 /sdcard 写入交给后台线程。
     * 之前这里是同步 FileWriter：音频回调每秒被外部存储 I/O 卡一次，就是那阵"电流声"。
     */
    static void diag(String line) {
        if (diagQueue.size() > 48) return;
        diagQueue.offer(System.currentTimeMillis() + " " + line);
    }

    private static void writeDiag(String line) {
        if (appendDiag(new File("/sdcard/Download/lx_sfx_diag.txt"), line)) return;
        // 分区存储/权限问题下 /sdcard 可能写不进去，退回到应用外部目录（无需任何权限）
        Context context = appContext;
        if (context == null) return;
        File dir = context.getExternalFilesDir(null);
        if (dir == null) dir = context.getFilesDir();
        appendDiag(new File(dir, "lx_sfx_diag.txt"), line);
    }

    private static boolean appendDiag(File file, String line) {
        try {
            if (file.length() > 200000) file.delete();
            FileWriter writer = new FileWriter(file, true);
            writer.write(line + "\n");
            writer.close();
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 音频线程每处理一块就记一次，用来确认 DSP 是否真的在跑 */
    public static void record(int frames, int channels, int rate, EffectSettings value) {
        processedFrames.addAndGet(frames);
        lastChannels = channels;
        lastRate = rate;
        lastMode = value.surroundMode;
        lastStrength = (float) value.surroundStrength;
        if (value.surroundMode != 0) surroundAppliedBlocks++;
        long now = System.currentTimeMillis();
        if (now - lastRunDiagAt > 2000) {
            lastRunDiagAt = now;
            diag("RUN frames=" + processedFrames.get() + " rate=" + rate + " ch=" + channels +
                " mode=" + value.surroundMode + " strength=" + value.surroundStrength +
                " eq=" + value.equalizer + " eqBands=" + eqBands + " eqNative=" + eqNative +
                " eqTrim=" + eqTrimDb + " eqLive=" + eqLiveBands +
                " eqMode=" + value.eqMode + " src=" + (value.source.isEmpty() ? "-" : value.source) +
                " surroundBlocks=" + surroundAppliedBlocks +
                " headTrack=" + value.headTrack + " hrtf=" + BinauralStage.ready() +
                " hiresOut=" + HiRes.activeOutputRate() + " hiresEff=" + HiRes.effectiveTarget() +
                " hiresDeg=" + HiRes.degradeCount() + " hiresCool=" + HiRes.cooldownRemainingMs() +
                " headset=" + AudioRoute.isHeadset() + " yaw=" + snapYaw() + " predict=" + snapPredict() +
                " vinyl=" + vinylAmount + " vinylNative=" + vinylNative + " vinylOs=" + vinylOs +
                " vinylDrive=" + vinylDriveDb + " vinylHiss=" + vinylHissDb);
        }
    }

    public static void noteAttach(boolean offload) {
        diag("ATTACH offload=" + offload + " build=hr-2 watchdog=1");
    }

    private static float snapYaw() {
        BinauralStage stage = BinauralStage.current();
        return stage == null ? 0f : stage.yaw();
    }

    private static float snapPredict() {
        BinauralStage stage = BinauralStage.current();
        return stage == null ? 0f : stage.prediction();
    }

    public static void noteConfigure(EffectSettings value) {
        diag("CONFIGURE mode=" + value.surroundMode + " strength=" + value.surroundStrength +
            " eq=" + value.equalizer + " src=" + (value.source.isEmpty() ? "-" : value.source));
    }

    /** Aurora-27：音频线程低频回报 31 段内核状态（只写 volatile，不做任何计算） */
    static void noteEq(boolean nativeKernel, int bands, float trimDb, int liveBands) {
        eqNative = nativeKernel;
        eqBands = bands;
        eqTrimDb = trimDb;
        eqLiveBands = liveBands;
    }

    /** Aurora-29：音频线程低频回报味精模块状态（只写 volatile，不做任何计算） */
    static void noteVinyl(boolean nativeKernel, float amount, int os, float driveDb, float hissDb) {
        vinylNative = nativeKernel;
        vinylAmount = amount;
        vinylOs = os;
        vinylDriveDb = driveDb;
        vinylHissDb = hissDb;
    }

    public static boolean vinylNative() { return vinylNative; }
    public static float vinylAmount() { return vinylAmount; }
    public static int vinylOs() { return vinylOs; }
    public static float vinylDriveDb() { return vinylDriveDb; }
    public static float vinylHissDb() { return vinylHissDb; }

    public static boolean eqNative() { return eqNative; }
    public static int eqBands() { return eqBands; }
    public static float eqTrimDb() { return eqTrimDb; }
    public static int eqLiveBands() { return eqLiveBands; }

    public static long processedFrames() { return processedFrames.get(); }
    public static int lastChannels() { return lastChannels; }
    public static int lastRate() { return lastRate; }
    public static int lastMode() { return lastMode; }
    public static float lastStrength() { return lastStrength; }
    public static boolean hasPrepared() { return prepared != null; }
    public static boolean headTrackReady() { return BinauralStage.ready(); }
    public static boolean headTrackLoaded() { return HrtfRenderer.available(); }
    public static String headTrackBackend() { return HrtfRenderer.version(); }
    public static String headTrackError() { return HrtfRenderer.loadError(); }
    public static boolean headset() { return AudioRoute.isHeadset(); }
    public static float headTrackYaw() { return snapYaw(); }
    public static float headTrackPredict() { return snapPredict(); }

    /** 限流记录一条错误，直接进 diag 文件 */
    static void noteError(String message) {
        long now = SystemClock.elapsedRealtime();
        if (now - lastErrorAt < 800) return;
        lastErrorAt = now;
        diag("ERR " + message);
    }

    private static void resetCheck() {
        checkAt = 0;
        checkFrames = -1;
        stalledChecks = 0;
    }

    /**
     * 音频管线看门狗（每 2 秒由 AudioRecovery 调用）：
     * 播放器在播、音效启用（非 offload）时，processedFrames 必须持续增长；
     * 连续两次没涨就判定底层 AudioTrack / PCM 流挂了，分级强制重建。
     */
    static void recoverCheck() {
        // Aurora-15 冷链防抖：降级/重建管线的 3 秒冷却期内，看门狗一律静默。
        // 切采样率时 AudioSink 会被 stop/prepare 重建，processedFrames 本来就会停一下，
        // 这时候如果照常判定「卡死」再补一脚 stop/prepare，就是雪崩闪退。
        if (HiRes.inCooldown()) {
            if (checkAt != 0 || stalledChecks != 0) diag("WATCHDOG_MUTED hires cooldown left=" + HiRes.cooldownRemainingMs() + "ms");
            resetCheck();
            return;
        }
        ExoPlayer p = player.get();
        if (p == null || !settings.active()) { resetCheck(); return; }
        boolean playing = p.getPlayWhenReady() && p.getPlaybackState() == Player.STATE_READY;
        if (!playing) { resetCheck(); return; }
        long frames = processedFrames();
        long now = SystemClock.elapsedRealtime();
        if (checkAt == 0) {
            checkFrames = frames;
            checkAt = now;
            return;
        }
        long elapsed = now - checkAt;
        long got = frames - checkFrames;
        long expected = (long) (Math.max(8000, sampleRate) * (elapsed / 1000.0) * 0.25);
        checkFrames = frames;
        checkAt = now;
        if (got >= expected) {
            stalledChecks = 0;
            recoverAttempts = 0;
            return;
        }
        stalledChecks++;
        noteError("stall frames+" + got + "<" + expected + " state=" + p.getPlaybackState() + " playing=" + p.isPlaying());
        if (stalledChecks < 2) return;
        stalledChecks = 0;
        recover(p);
    }

    private static void recover(ExoPlayer p) {
        final int attempt = ++recoverAttempts;
        final long pos = Math.max(0, p.getCurrentPosition());
        noteError("RECOVER#" + attempt + " pos=" + pos);
        new Handler(p.getApplicationLooper()).post(() -> {
            try {
                if (attempt <= 1) {
                    // 一级：seek 触发 sink flush + 重新 play
                    p.seekTo(pos);
                    if (!p.isPlaying()) p.play();
                } else {
                    // 二级：彻底重建渲染管线（stop→prepare→seek→play）
                    p.stop();
                    p.prepare();
                    p.seekTo(pos);
                    p.play();
                }
                BinauralStage stage = BinauralStage.current();
                if (stage != null) stage.reset();
                noteError("RECOVER#" + attempt + " done");
            } catch (Throwable error) {
                noteError("RECOVER#" + attempt + " failed " + error);
            }
        });
    }

    public static EffectSettings settings() {
        return settings;
    }

    static Prepared prepared() {
        return prepared;
    }

    /** 震动开关会决定要不要保留 PCM 直通（关闭 offload），改完必须重算 */
    public static void refreshOffload() {
        updateOffload();
    }

    /** 悬浮灵动岛可见时强制保留 PCM 通路（关掉 offload），否则频谱取不到数据 */
    public static void setForceStream(boolean value) {
        forceStream = value;
        updateOffload();
    }

    public static synchronized void attachPlayer(ExoPlayer value, boolean offload) {
        player = new WeakReference<>(value);
        AudioRecovery.start();
        checkAt = 0;
        stalledChecks = 0;
        recoverAttempts = 0;
        allowOffload = offload;
        noteAttach(offload);
        updateOffload();
    }

    public static synchronized void detachPlayer(androidx.media3.common.Player value) {
        if (player.get() == value) player.clear();
    }

    private static synchronized void updateOffload() {
        ExoPlayer value = player.get();
        if (value == null) return;
        new Handler(value.getApplicationLooper()).post(() -> {
            if (player.get() != value) return;
            value.setTrackSelectionParameters(value.getTrackSelectionParameters().buildUpon()
                .setAudioOffloadPreferences(new TrackSelectionParameters.AudioOffloadPreferences.Builder()
                    .setAudioOffloadMode(allowOffload && !forceStream && !settings.active() && !HapticBass.isEnabled() && !HiRes.enabled()
                        ? TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED
                        : TrackSelectionParameters.AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_DISABLED)
                    .setIsGaplessSupportRequired(true).build()).build());
        });
    }

    /**
     * 立即重建音频管线（升频开关切换时用）：走二级恢复 stop→prepare→seek→play，
     * 这是现成验证过的路径，比直接动 AudioSink 稳。
     */
    public static void rebuildSink() {
        ExoPlayer value = player.get();
        if (value == null) {
            diag("REBUILD skipped: no player attached");
            return;
        }
        new Handler(value.getApplicationLooper()).post(() -> {
            try {
                final long pos = Math.max(0, value.getCurrentPosition());
                final boolean playing = value.getPlayWhenReady();
                value.stop();
                value.prepare();
                value.seekTo(pos);
                if (playing) value.play();
                diag("REBUILD sink pos=" + pos + " hiresOut=" + HiRes.activeOutputRate()
                    + " effective=" + HiRes.effectiveTarget());
            } catch (Throwable error) {
                noteError("REBUILD failed " + error);
            }
        });
    }

    public static void configure(Context context, EffectSettings value, Completion completion) {
        if (context != null) appContext = context.getApplicationContext();
        settings = value;
        noteConfigure(value);
        updateOffload();
        updateBinaural(context);
        prepare(context, completion);
    }

    /** 头追开关：开则后台建 HRTF（解析数据较慢），关则让音频线程立刻旁路 */
    static void updateBinaural(Context context) {
        EffectSettings current = settings;
        if (current.headTrack) {
            int rate = sampleRate;
            worker.execute(() -> BinauralStage.prepare(context, rate, PartitionedConvolver.BLOCK));
        } else {
            BinauralStage.stop();
        }
    }

    static void setSampleRate(Context context, int rate) {
        if (rate == sampleRate && (prepared == null || prepared.rate == rate)) { updateBinaural(context); return; }
        sampleRate = rate;
        updateBinaural(context);
        prepare(context, error -> {
            if (error != null) android.util.Log.e("LXSoundEffects", "Could not prepare impulse", error);
        });
    }

    private static void prepare(Context context, Completion completion) {
        EffectSettings current = settings;
        int rate = sampleRate;
        long generation = revision.incrementAndGet();
        if (current.source.isEmpty()) {
            prepared = null;
            completion.complete(null);
            return;
        }
        Prepared ready = prepared;
        if (ready != null && ready.source.equals(current.source) && ready.rate == rate) {
            completion.complete(null);
            return;
        }
        worker.execute(() -> {
            if (generation != revision.get()) { completion.complete(null); return; }
            try {
                // 小型变换保持单线程以降低音频回调抖动
                ConcurrencyUtils.setNumberOfThreads(1);
                if (!cachedSource.equals(current.source)) {
                    try (InputStream input = context.getAssets().open("lx_sound_effects/" + current.source)) {
                        cachedImpulse = WaveImpulse.read(input);
                        cachedSource = current.source;
                    }
                }
                PartitionedConvolver engine = new PartitionedConvolver(cachedImpulse.resample(rate), rate, true);
                if (generation == revision.get()) prepared = new Prepared(current.source, rate, engine);
                completion.complete(null);
            } catch (Exception error) {
                completion.complete(generation == revision.get() ? error : null);
            }
        });
    }
}
