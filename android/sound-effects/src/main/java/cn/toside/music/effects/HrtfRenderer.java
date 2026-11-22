package cn.toside.music.effects;

/**
 * Steam Audio 双耳渲染的 Java 壳。热路径只做一次 JNI 调用，不分配内存。
 * 加载失败（例如非 arm64 包）时 available() 为 false，上层自动关闭头追。
 */
public final class HrtfRenderer {
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

    public static boolean available() {
        return LOADED;
    }

    public static String loadError() {
        return LOAD_ERROR;
    }

    public static String version() {
        if (!LOADED) return "unavailable";
        try {
            return nativeVersion();
        } catch (Throwable throwable) {
            return "error";
        }
    }

    private long handle;
    private final int sampleRate;
    private final int frameSize;
    private final float[] listener = new float[9];

    private HrtfRenderer(long handle, int sampleRate, int frameSize) {
        this.handle = handle;
        this.sampleRate = sampleRate;
        this.frameSize = frameSize;
    }

    /** 创建开销较大（解析 HRTF 数据），只能在非音频线程调用。 */
    static HrtfRenderer create(int sampleRate, int frameSize) {
        if (!LOADED) return null;
        long handle = 0;
        try {
            handle = nativeCreate(sampleRate, frameSize);
        } catch (Throwable ignored) {
        }
        if (handle == 0) return null;
        return new HrtfRenderer(handle, sampleRate, frameSize);
    }

    int sampleRate() {
        return sampleRate;
    }

    int frameSize() {
        return frameSize;
    }

    boolean matches(int rate, int frames) {
        return sampleRate == rate && frameSize == frames;
    }

    /** 音频线程调用：原地把 left/right 换成 HRTF 渲染后的双耳信号。 */
    boolean process(float[] left, float[] right, int frames) {
        long current = handle;
        if (current == 0 || left == null || right == null || frames <= 0) return false;
        try {
            return nativeProcess(current, left, right, frames) == 0;
        } catch (Throwable throwable) {
            return false;
        }
    }

    /** seek / 暂停恢复时清掉卷积残留（音频线程调用，内部不分配） */
    void reset() {
        long current = handle;
        if (current == 0) return;
        try {
            nativeReset(current);
        } catch (Throwable ignored) {
        }
    }

    void setListener(float[] values) {
        long current = handle;
        if (current == 0 || values == null || values.length < 9) return;
        System.arraycopy(values, 0, listener, 0, 9);
        try {
            nativeSetListener(current, listener);
        } catch (Throwable ignored) {
        }
    }

    /** 只允许在确认音频线程不再使用之后调用。 */
    void release() {
        long current = handle;
        handle = 0;
        if (current == 0) return;
        try {
            nativeDestroy(current);
        } catch (Throwable ignored) {
        }
    }

    private static native long nativeCreate(int sampleRate, int frameSize);

    private static native void nativeDestroy(long handle);

    private static native void nativeSetListener(long handle, float[] values);

    private static native int nativeProcess(long handle, float[] left, float[] right, int frames);

    private static native void nativeReset(long handle);

    private static native String nativeVersion();
}
