package cn.toside.music.effects;

/**
 * 音频可视化取数（参数对齐 lx-music-desktop 的 AnalyserNode 用法）。
 *
 * 桌面版：AnalyserNode.fftSize = 256 → 128 个 bin，dB 窗口 [-100,-30] 映射到 0..255，
 * 帧间平滑系数 0.8，rAF 驱动。这里照搬同一套参数，保证手机端看起来和桌面版一致。
 *
 * 线程模型（关键）：
 * - 音频线程只调 feed()：一次环形缓冲拷贝，128 个 float 写入，无分支无分配；
 * - FFT / 分带 / 平滑全部发生在调用 analyze() 的线程（JS 每帧轮询时），
 *   因此音频链路上没有多出来的计算，也不会卡音频回调。
 */
public final class VisualizerTap {
    public static final int FFT_SIZE = 1024;
    public static final int BIN_COUNT = FFT_SIZE / 2;
    public static final int MAX_BARS = BIN_COUNT;

    private static final float MIN_DB = -100f;
    private static final float MAX_DB = -30f;
    // 0.8 是 AnalyserNode 的默认值，但那是 60fps 下的观感；这里降到 0.6，剩下的时间平滑交给 JS 做
    private static final float SMOOTH = 0.6f;
    private static final float BAND_LOW_HZ = 50f;
    private static final float BAND_HIGH_HZ = 16000f;
    private static final int RING = 4096;

    private static final float[] ring = new float[RING];
    private static volatile int ringWrite;
    private static volatile long written;
    private static volatile boolean enabled;

    private static final float[] window = new float[FFT_SIZE];
    private static final double[] twiddleCos = new double[FFT_SIZE / 2];
    private static final double[] twiddleSin = new double[FFT_SIZE / 2];
    private static final int[] bitReverse = new int[FFT_SIZE];
    private static final float[] re = new float[FFT_SIZE];
    private static final float[] im = new float[FFT_SIZE];
    private static final float[] samples = new float[FFT_SIZE];
    private static final float[] magnitude = new float[BIN_COUNT];
    private static final float[] spectrum = new float[BIN_COUNT];

    private static long lastTotal = -1L;
    private static boolean lastFresh;
    private static float lastRms;
    private static int[] bandEdges = new int[0];
    private static int bandCount;
    private static int bandRate;

    static {
        for (int i = 0; i < FFT_SIZE; i++) {
            window[i] = (float) (0.5d - 0.5d * Math.cos(2d * Math.PI * i / (FFT_SIZE - 1)));
        }
        for (int i = 0; i < FFT_SIZE / 2; i++) {
            double angle = -2d * Math.PI * i / FFT_SIZE;
            twiddleCos[i] = Math.cos(angle);
            twiddleSin[i] = Math.sin(angle);
        }
        int bits = Integer.numberOfTrailingZeros(FFT_SIZE);
        for (int i = 0; i < FFT_SIZE; i++) bitReverse[i] = Integer.reverse(i) >>> (32 - bits);
    }

    private VisualizerTap() {}

    /** 由 JS 开关：没人看的时候连环形缓冲的拷贝都省掉 */
    public static void setEnabled(boolean value) {
        enabled = value;
        if (!value) {
            written = 0;
            lastTotal = -1L;
            ringWrite = 0;
            java.util.Arrays.fill(ring, 0f);
            java.util.Arrays.fill(spectrum, 0f);
            lastRms = 0f;
        }
    }

    public static boolean isEnabled() {
        return enabled;
    }

    /** 音频线程调用：只做拷贝 */
    public static void feed(float[][] input, int channels, int frames) {
        if (!enabled || frames <= 0) return;
        float[] left = input[0];
        float[] right = channels > 1 ? input[1] : null;
        int w = ringWrite;
        for (int i = 0; i < frames; i++) {
            ring[w] = right == null ? left[i] : (left[i] + right[i]) * 0.5f;
            if (++w == RING) w = 0;
        }
        ringWrite = w;
        written += frames;
    }

    /**
     * 取一帧可视化数据。
     *
     * @param count 柱子数量（按屏幕宽度自适应，4..128）
     * @param rate  当前采样率（0 则按 48000）
     * @return 长度 count 的 0..255 柱高数组
     */
    public static synchronized int[] analyze(int count, int rate) {
        int bars = count < 4 ? 4 : Math.min(count, MAX_BARS);
        int sampleRate = rate > 0 ? rate : 48000;
        long total = written;
        boolean fresh = total > 0 && total != lastTotal;
        lastFresh = fresh;
        if (fresh) {
            lastTotal = total;
            // 从环形缓冲取最近 FFT_SIZE 个样本（拷贝期间写入器最多再走几十个样本，视觉上无影响）
            int start = ringWrite - FFT_SIZE;
            if (start < 0) start += RING;
            for (int i = 0; i < FFT_SIZE; i++) {
                int index = start + i;
                if (index >= RING) index -= RING;
                samples[i] = ring[index];
            }
            computeSpectrum(samples);
        }
        int[] out = new int[bars];
        updateBands(bars, sampleRate);
        for (int bar = 0; bar < bars; bar++) {
            int from = bandEdges[bar];
            int to = bandEdges[bar + 1];
            if (to <= from) to = Math.min(BIN_COUNT, from + 1);
            // RMS 而不是 max：宽频带里单个尖峰会顶出一根抽搐的柱子，取均方根稳得多
            float sum = 0f;
            for (int bin = from; bin < to; bin++) sum += spectrum[bin] * spectrum[bin];
            float value = (float) Math.sqrt(sum / (to - from));
            out[bar] = (int) (value + 0.5f);
        }
        return out;
    }

    public static synchronized boolean isFresh() {
        return lastFresh;
    }

    public static synchronized float lastRms() {
        return lastRms;
    }

    private static void computeSpectrum(float[] samples) {
        double energy = 0d;
        for (int i = 0; i < FFT_SIZE; i++) {
            float value = samples[i];
            energy += value * (double) value;
            re[i] = value * window[i];
            im[i] = 0f;
        }
        lastRms = (float) Math.sqrt(energy / FFT_SIZE);
        fft();
        // 归一化：满量程正弦 → 1.0
        float scale = 2f / FFT_SIZE;
        for (int bin = 0; bin < BIN_COUNT; bin++) {
            float magnitudeValue = (float) Math.sqrt(re[bin] * (double) re[bin] + im[bin] * (double) im[bin]) * scale;
            magnitude[bin] = magnitudeValue;
            float db = 20f * (float) Math.log10(magnitudeValue < 1e-7f ? 1e-7f : magnitudeValue);
            float normalized = (db - MIN_DB) / (MAX_DB - MIN_DB);
            if (normalized < 0f) normalized = 0f;
            else if (normalized > 1f) normalized = 1f;
            // AnalyserNode 同款帧间平滑
            spectrum[bin] = SMOOTH * spectrum[bin] + (1f - SMOOTH) * normalized * 255f;
        }
    }

    private static void fft() {
        for (int i = 0; i < FFT_SIZE; i++) {
            int j = bitReverse[i];
            if (j > i) {
                float tr = re[i]; re[i] = re[j]; re[j] = tr;
                float ti = im[i]; im[i] = im[j]; im[j] = ti;
            }
        }
        for (int size = 2; size <= FFT_SIZE; size <<= 1) {
            int half = size >> 1;
            int step = FFT_SIZE / size;
            for (int start = 0; start < FFT_SIZE; start += size) {
                for (int k = 0; k < half; k++) {
                    double wr = twiddleCos[k * step];
                    double wi = twiddleSin[k * step];
                    int a = start + k;
                    int b = a + half;
                    float vr = (float) (re[b] * wr - im[b] * wi);
                    float vi = (float) (re[b] * wi + im[b] * wr);
                    re[b] = re[a] - vr;
                    im[b] = im[a] - vi;
                    re[a] += vr;
                    im[a] += vi;
                }
            }
        }
    }

    /** 对数分带：45Hz 起按等比切，低频给更多柱子，避免手机上低频全挤在第一根 */
    private static void updateBands(int bars, int rate) {
        if (bandCount == bars && bandRate == rate && bandEdges.length == bars + 1) return;
        bandCount = bars;
        bandRate = rate;
        bandEdges = new int[bars + 1];
        double binHz = (double) rate / FFT_SIZE;
        int usable = (int) Math.min(BIN_COUNT - 1, Math.round(Math.min(BAND_HIGH_HZ, rate * 0.5d) / binHz));
        if (usable < bars) usable = bars;
        // 边界按理想对数曲线取整；某根柱子宽度不足 1 个 bin 时（低频分辨率不够）由 analyze 里
        // 「至少取一个 bin」兜底，这样 1kHz 还是落在它该在的位置，不会把低频全挤到前面几根上
        bandEdges[0] = 0;
        for (int i = 1; i <= bars; i++) {
            double freq = BAND_LOW_HZ * Math.pow((double) usable * binHz / BAND_LOW_HZ, (double) i / bars);
            int bin = (int) Math.round(freq / binHz);
            if (bin < 0) bin = 0;
            if (bin > BIN_COUNT) bin = BIN_COUNT;
            bandEdges[i] = bin;
        }
        if (bandEdges[bars] < usable) bandEdges[bars] = Math.min(BIN_COUNT, usable);
    }
}
