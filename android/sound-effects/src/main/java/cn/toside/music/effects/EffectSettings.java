package cn.toside.music.effects;

public final class EffectSettings {
    public static final int[] FREQUENCIES = {31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000};

    /** Aurora-27：31 段（三分之一倍频程）中心频率，与 cpp/eq31.h 里的表逐项一致 */
    public static final float[] FREQUENCIES_31 = {
        20f, 25f, 31.5f, 40f, 50f, 63f, 80f, 100f, 125f, 160f,
        200f, 250f, 315f, 400f, 500f, 630f, 800f, 1000f, 1250f, 1600f,
        2000f, 2500f, 3150f, 4000f, 5000f, 6300f, 8000f, 10000f, 12500f, 16000f,
        20000f,
    };
    public static final int MODE_TEN = 10;
    public static final int MODE_31 = 31;

    public static final EffectSettings OFF = new EffectSettings(false, new double[10], "", 1, 0, 0, 0, 0.12, false);

    public final boolean equalizer;
    public final double[] gains;
    /** 均衡段数：10（老十段）或 31（三分之一倍频程） */
    public final int eqMode;
    /** 31 段增益（dB），与 FREQUENCIES_31 一一对应 */
    public final double[] gains31;
    /** 自动预衰减：正增益超过 +6dB 的部分抵掉，防止叠加增益把限幅器压爆 */
    public final boolean eqHeadroom;
    public final String source;
    public final double dry;
    public final double wet;
    /** 环绕：0 关 / 1 宽阔 / 2 沉浸 / 3 旋转 / 4 蝰蛇 */
    public final int surroundMode;
    /** 环绕强度 0..1 */
    public final double surroundStrength;
    /** 旋转速度 Hz（0.02..0.6） */
    public final double surroundSpeed;
    /** 头追双耳渲染（需要耳机 + 陀螺仪） */
    public final boolean headTrack;

    // ---- Aurora-29：模拟黑胶 / 胆机 ----
    /** 味精加量 0..1（0 = 完全直通） */
    public final double vinylAmount;
    /** 胆机软削波（偶次谐波） */
    public final boolean vinylTube;
    /** 黑胶底噪（嘶声 + 颗粒） */
    public final boolean vinylNoise;
    /** Wow & Flutter（肉摇） */
    public final boolean vinylWow;
    /** true = 4 倍过采样（高保真），false = 2 倍（省电） */
    public final boolean vinylHiFi;
    /** Aurora-30：16kHz 陡峭低通（蓝牙编解码吃不下 16k 以上，会让它变滋滋声） */
    public final boolean vinylLpf;

    public EffectSettings(boolean equalizer, double[] gains, String source, double dry, double wet,
                          int surroundMode, double surroundStrength, double surroundSpeed, boolean headTrack) {
        this(equalizer, gains, source, dry, wet, surroundMode, surroundStrength, surroundSpeed, headTrack,
            MODE_TEN, null, true, 0, true, true, true, true, true);
    }

    public EffectSettings(boolean equalizer, double[] gains, String source, double dry, double wet,
                          int surroundMode, double surroundStrength, double surroundSpeed, boolean headTrack,
                          int eqMode, double[] gains31, boolean eqHeadroom) {
        this(equalizer, gains, source, dry, wet, surroundMode, surroundStrength, surroundSpeed, headTrack,
            eqMode, gains31, eqHeadroom, 0, true, true, true, true, true);
    }

    public EffectSettings(boolean equalizer, double[] gains, String source, double dry, double wet,
                          int surroundMode, double surroundStrength, double surroundSpeed, boolean headTrack,
                          int eqMode, double[] gains31, boolean eqHeadroom,
                          double vinylAmount, boolean vinylTube, boolean vinylNoise, boolean vinylWow, boolean vinylHiFi,
                          boolean vinylLpf) {
        if (gains.length != FREQUENCIES.length) throw new IllegalArgumentException("Invalid equalizer bands");
        double[] wide = gains31 == null ? new double[FREQUENCIES_31.length] : gains31;
        if (wide.length != FREQUENCIES_31.length) throw new IllegalArgumentException("Invalid 31-band equalizer bands");
        this.equalizer = equalizer;
        this.gains = gains.clone();
        for (double gain : gains) check(gain, -15, 15);
        this.gains31 = wide.clone();
        for (double gain : this.gains31) check(gain, -15, 15);
        this.eqMode = eqMode == MODE_31 ? MODE_31 : MODE_TEN;
        this.eqHeadroom = eqHeadroom;
        check(dry, 0, 5);
        check(wet, 0, 5);
        if (!source.isEmpty() && !source.matches("[a-zA-Z0-9_-]+[.]wav")) {
            throw new IllegalArgumentException("Invalid impulse source");
        }
        this.source = source;
        this.dry = dry;
        this.wet = wet;
        int mode = surroundMode < 0 || surroundMode > 4 ? 0 : surroundMode;
        this.surroundMode = mode;
        check(surroundStrength, 0, 1);
        this.surroundStrength = surroundStrength;
        double speed = Double.isNaN(surroundSpeed) ? 0.12 : surroundSpeed;
        if (speed < 0.02) speed = 0.02;
        if (speed > 0.6) speed = 0.6;
        this.surroundSpeed = speed;
        this.headTrack = headTrack;
        // 味精加量：脏数据一律当 0（直通），绝不因为一个 NaN 让整条链变成静音
        double amount = Double.isNaN(vinylAmount) || Double.isInfinite(vinylAmount) ? 0 : vinylAmount;
        if (amount < 0) amount = 0;
        if (amount > 1) amount = 1;
        this.vinylAmount = amount;
        this.vinylTube = vinylTube;
        this.vinylNoise = vinylNoise;
        this.vinylWow = vinylWow;
        this.vinylHiFi = vinylHiFi;
        this.vinylLpf = vinylLpf;
    }

    public boolean active() {
        return equalizer || !source.isEmpty() || surroundMode != 0 || headTrack || vinylActive();
    }

    /** 味精模块是否在起作用（有声才需要跑，省电） */
    public boolean vinylActive() {
        return vinylAmount > 0 && (vinylTube || vinylNoise || vinylWow);
    }

    private static void check(double value, double min, double max) {
        if (Double.isNaN(value) || Double.isInfinite(value) || value < min || value > max) {
            throw new IllegalArgumentException("Effect value outside range");
        }
    }
}
