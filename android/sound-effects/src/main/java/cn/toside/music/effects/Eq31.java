package cn.toside.music.effects;

/**
 * Aurora-27：31 段（三分之一倍频程）均衡器的 Java 包装，真正的 DSP 在 cpp/eq31.h。
 *
 * 安全约定：
 *  · 原生库加载失败 / 建句柄失败 → create() 返回 0，上层自动退回 Java 十段实现，
 *    绝不因为"31 段用不了"就整条音效链没声音；
 *  · 所有 native 调用都包 try/catch，音频线程不允许因为 JNI 抛异常而中断；
 *  · setParams 走 std::atomic，UI 线程每帧刷新设置也不会撕裂参数。
 */
public final class Eq31 {
    private static final boolean LOADED;

    static {
        boolean ok;
        try {
            System.loadLibrary("yieyu_hrtf");
            ok = true;
        } catch (Throwable error) {
            ok = false;
        }
        LOADED = ok;
    }

    private Eq31() {}

    /** 本机是否有 C++ 内核（32 位 ABI 没有编这个库时会是 false） */
    public static boolean available() {
        return LOADED;
    }

    public static long create(int sampleRate, int channels) {
        if (!LOADED) return 0;
        try {
            return nativeCreate(sampleRate, channels);
        } catch (Throwable error) {
            return 0;
        }
    }

    public static void release(long handle) {
        if (!LOADED || handle == 0) return;
        try {
            nativeRelease(handle);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 下发参数：十段/三十一段增益、当前段数（10 或 31）、总开关、自动预衰减。
     * bands 传 0 表示关闭均衡（31 段算力吃不住时可以整体关掉）。
     */
    public static void setParams(long handle, float[] gains10, float[] gains31,
                                 int bands, boolean enabled, boolean headroom) {
        if (!LOADED || handle == 0) return;
        try {
            nativeSetParams(handle, gains10, gains31, bands, enabled, headroom);
        } catch (Throwable ignored) {
        }
    }

    /** 就地处理 channels 个声道（非交织，每声道一个 float[]），全是已配置好的定长缓冲 */
    public static void process(long handle, float[][] channels, int frames, int channelCount) {
        if (!LOADED || handle == 0) return;
        try {
            nativeProcess(handle, channels, frames, channelCount);
        } catch (Throwable ignored) {
        }
    }

    public static void reset(long handle) {
        if (!LOADED || handle == 0) return;
        try {
            nativeReset(handle);
        } catch (Throwable ignored) {
        }
    }

    /** 自动预衰减当前值（dB，<=0），给 UI 诚实显示用 */
    public static float trimDb(long handle) {
        if (!LOADED || handle == 0) return 0f;
        try {
            return nativeTrimDb(handle);
        } catch (Throwable error) {
            return 0f;
        }
    }

    /** 当前实际在跑的滤波器分节数（调音时远小于 31） */
    public static int liveBands(long handle) {
        if (!LOADED || handle == 0) return 0;
        try {
            return nativeLiveBands(handle);
        } catch (Throwable error) {
            return 0;
        }
    }

    private static native long nativeCreate(int sampleRate, int channels);

    private static native void nativeRelease(long handle);

    private static native void nativeSetParams(long handle, float[] gains10, float[] gains31,
                                               int bands, boolean enabled, boolean headroom);

    private static native void nativeProcess(long handle, float[][] channels, int frames, int channelCount);

    private static native void nativeReset(long handle);

    private static native float nativeTrimDb(long handle);

    private static native int nativeLiveBands(long handle);
}
