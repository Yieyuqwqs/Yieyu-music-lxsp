package cn.toside.music.effects;

/**
 * Aurora-29：【模拟黑胶 / 胆机】的 Java 包装，真正的 DSP 在 cpp/vinyl.h。
 *
 * 安全约定（与 Eq31 一致）：
 *  · 原生库加载失败 / 建句柄失败 → create() 返回 0，上层自动降级为直通，绝不失声；
 *  · 所有 native 调用都包 try/catch，音频线程不允许因为 JNI 抛异常而中断；
 *  · setParams 走 std::atomic，UI 线程连续拖动滑块也不会撕裂参数。
 */
public final class Vinyl {
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

    private Vinyl() {}

    /** 本机是否有 C++ 内核（32 位 ABI 没编这个库时是 false） */
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
     * 下发参数。
     *
     * @param amount 味精加量 0..1（0 = 完全直通）
     * @param tube   胆机软削波开关
     * @param noise  黑胶底噪开关
     * @param wow    肉摇（Wow &amp; Flutter）开关
     * @param hiFi   true = 4 倍过采样，false = 2 倍（省电）
     * @param enabled 总开关
     * @param lpf     true = 挂 16kHz 陡峭低通（蓝牙防高频毛刺）
     */
    public static void setParams(long handle, float amount, boolean tube, boolean noise,
                                 boolean wow, boolean hiFi, boolean enabled, boolean lpf) {
        if (!LOADED || handle == 0) return;
        try {
            nativeSetParams(handle, amount, tube, noise, wow, hiFi, enabled, lpf);
        } catch (Throwable ignored) {
        }
    }

    /** 就地处理 channels 个声道（非交织，每声道一个 float[]） */
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

    /** 当前实际过采样倍数（4/2/1），给面板诚实显示 */
    public static int osFactor(long handle) {
        if (!LOADED || handle == 0) return 0;
        try {
            return nativeOsFactor(handle);
        } catch (Throwable error) {
            return 0;
        }
    }

    /** 当前嘶声电平（dBFS，<=0） */
    public static float hissDb(long handle) {
        if (!LOADED || handle == 0) return -86f;
        try {
            return nativeHissDb(handle);
        } catch (Throwable error) {
            return -86f;
        }
    }

    /** 当前胆机驱动量（dB） */
    public static float driveDb(long handle) {
        if (!LOADED || handle == 0) return 0f;
        try {
            return nativeDriveDb(handle);
        } catch (Throwable error) {
            return 0f;
        }
    }

    private static native long nativeCreate(int sampleRate, int channels);

    private static native void nativeRelease(long handle);

    private static native void nativeSetParams(long handle, float amount, boolean tube, boolean noise,
                                               boolean wow, boolean hiFi, boolean enabled, boolean lpf);

    private static native void nativeProcess(long handle, float[][] channels, int frames, int channelCount);

    private static native void nativeReset(long handle);

    private static native int nativeOsFactor(long handle);

    private static native float nativeHissDb(long handle);

    private static native float nativeDriveDb(long handle);
}
