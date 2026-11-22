package cn.toside.music.effects;

import java.util.Arrays;

/**
 * 虚拟环绕（PCM 层，v2 重写：去掉全部反馈/梳状结构，只做线性、可逆、无染色的处理）。
 *
 * 结构（全部按样本推进，权重 20ms one-pole 平滑）：
 * 1. 一阶分频 200Hz：低频做单声道化（避免低频绕动发虚），中高频做 M/S 加宽。
 * 2. 加宽只用「侧声道纯增益」（Sh *= 1+w）：中频完全不动，所以人声不会被掏空、
 *    也没有任何梳状波纹——这是上一版"声场近/不自然"和"电流声"的主因。
 * 3. 交叉馈电：对侧中高频 0.6ms 延迟（±LFO 扫动）+ 1.6kHz 低通，电平 ≤ -14dB，
 *    对应真实头影/耳间时差，给出"声在头外"的线索。
 * 4. 空间反射：对侧 2.4ms 单抽头（±LFO 扫动）+ 3kHz 低通，电平 ≤ -20dB，营造房间感。
 * 5. 旋转：中频 M*sin(LFO) 反相摆动 + 上述两条时延一起扫，整场左右摆而不是改音色。
 * 6. 门控：按实测 side/mid 能量比把空间项关掉——单声道素材(纯人声/老歌)完全不加空间项，
 *    杜绝梳状染色。
 * 7. 电平：按实测能量自适应补偿（能量守恒），换档不掉音量、峰值不涨。
 *
 * 没有任何反馈回路，静音输入输出恒为 0，不会自激。
 */
public final class SurroundProcessor {
    public static final int MODE_OFF = 0;
    public static final int MODE_WIDE = 1;
    public static final int MODE_IMMERSE = 2;
    public static final int MODE_ROTATE = 3;
    public static final int MODE_VIPER = 4;

    private static final float SPLIT_HZ = 200f;
    private static final float CROSS_LP_HZ = 1600f;
    private static final float REFLECT_LP_HZ = 3000f;
    private static final float SMOOTH_SECONDS = 0.020f;
    private static final float ENERGY_SECONDS = 0.300f;
    private static final float GAIN_SECONDS = 0.060f;
    private static final float GATE_OFF_RATIO = 0.004f;
    private static final float GATE_ON_RATIO = 0.090f;
    private static final float ROTATE_MID_DEPTH = 0.35f;
    private static final float OUTPUT_TRIM = 1.045f;

    private int mode = MODE_OFF;
    private int sampleRate = 44100;
    private float strength = 0f;
    private float speed = 0.12f;

    private float targetWide, targetCross, targetReflect, targetRotate, targetBass;
    private float wide, cross, reflect, rotate, bassMono;
    private boolean dirty = true;

    private float smoothCoef, energyCoef, gainCoef;
    private float splitA0, crossA0, reflectA0;

    private float loL, loR;
    private float crossLpL, crossLpR;
    private float reflectLpL, reflectLpR;

    private float[] delayL = new float[0];
    private float[] delayR = new float[0];
    private int delaySize, write;
    private int crossDelay, crossSpan, reflectDelay, reflectSpan;
    private double phase;

    private float midEnergy, sideEnergy;
    private float gate, gain = 1f;

    public void setSampleRate(int rate) {
        if (rate <= 0) return;
        sampleRate = rate;
        delaySize = Math.max(512, Math.round(rate * 0.024f));
        delayL = new float[delaySize];
        delayR = new float[delaySize];
        write = 0;
        crossDelay = Math.round(0.0006f * rate);
        crossSpan = Math.round(0.0003f * rate);
        reflectDelay = Math.round(0.0024f * rate);
        reflectSpan = Math.round(0.0006f * rate);
        splitA0 = (float) (1d - Math.exp(-2d * Math.PI * SPLIT_HZ / rate));
        crossA0 = (float) (1d - Math.exp(-2d * Math.PI * CROSS_LP_HZ / rate));
        reflectA0 = (float) (1d - Math.exp(-2d * Math.PI * REFLECT_LP_HZ / rate));
        smoothCoef = (float) (1d - Math.exp(-128d / (SMOOTH_SECONDS * rate)));
        energyCoef = (float) (1d - Math.exp(-1d / (ENERGY_SECONDS * rate)));
        gainCoef = (float) (1d - Math.exp(-1d / (GAIN_SECONDS * rate)));
        dirty = true;
    }

    public void set(int mode, float strength, float speed) {
        int nextMode = mode >= MODE_OFF && mode <= MODE_VIPER ? mode : MODE_OFF;
        float nextStrength = strength < 0f ? 0f : strength > 1f ? 1f : strength;
        float nextSpeed = speed < 0.02f ? 0.02f : speed > 0.6f ? 0.6f : speed;
        if (this.mode == nextMode && Math.abs(this.strength - nextStrength) < 1e-4f && Math.abs(this.speed - nextSpeed) < 1e-4f) return;
        this.mode = nextMode;
        this.strength = nextStrength;
        this.speed = nextSpeed;
        dirty = true;
    }

    /** 关闭后权重衰减到 0 之前还要继续处理，否则会留下半个效果 */
    public boolean active() {
        return mode != MODE_OFF || wide > 1e-4f || cross > 1e-4f || reflect > 1e-4f || rotate > 1e-4f || bassMono > 1e-4f;
    }

    public void reset() {
        loL = loR = 0f;
        crossLpL = crossLpR = 0f;
        reflectLpL = reflectLpR = 0f;
        midEnergy = sideEnergy = 0f;
        gate = 0f;
        gain = 1f;
        phase = 0d;
        write = 0;
        if (delayL.length > 0) {
            Arrays.fill(delayL, 0f);
            Arrays.fill(delayR, 0f);
        }
        wide = cross = reflect = rotate = bassMono = 0f;
    }

    public void process(float[][] input, int channels, int frames) {
        if (channels < 2 || frames <= 0 || delaySize == 0 || !active()) return;
        updateTargets();
        smooth();
        float[] left = input[0];
        float[] right = input[1];

        final float aSplit = splitA0;
        final float aCross = crossA0;
        final float aReflect = reflectA0;
        final float aEnergy = energyCoef;
        final float aGain = gainCoef;
        final int size = delaySize;

        final float sideGain = 1f + wide;
        final float crossGain = cross;
        final float reflectGain = reflect;
        final float midDepth = rotate * ROTATE_MID_DEPTH;
        final float bass = bassMono;
        final boolean spinning = rotate > 0.001f;
        final double increment = 2d * Math.PI * speed / sampleRate;
        final float gateScale = gate;
        final float gatedCross = crossGain * gateScale;
        final float gatedReflect = reflectGain * gateScale;
        final float gatedMid = midDepth * gateScale;

        float loLowL = loL;
        float loLowR = loR;
        float clL = crossLpL;
        float clR = crossLpR;
        float rlL = reflectLpL;
        float rlR = reflectLpR;
        float m2 = midEnergy;
        float s2 = sideEnergy;
        float g = gain;
        double ph = phase;
        int w = write;

        for (int i = 0; i < frames; i++) {
            float inL = left[i];
            float inR = right[i];
            loLowL += aSplit * (inL - loLowL);
            loLowR += aSplit * (inR - loLowR);
            float hiL = inL - loLowL;
            float hiR = inR - loLowR;
            float mid = (hiL + hiR) * 0.5f;
            float side = (hiL - hiR) * 0.5f;
            m2 += aEnergy * (mid * mid - m2);
            s2 += aEnergy * (side * side - s2);

            float pan = spinning ? (float) Math.sin(ph) : 0f;
            // 时延用线性插值读取：LFO 扫动时不会有一采样一跳的"拉链"声
            float readCross = w - (crossDelay + crossSpan * rotate * pan);
            while (readCross < 0f) readCross += size;
            float readReflect = w - (reflectDelay + reflectSpan * rotate * pan);
            while (readReflect < 0f) readReflect += size;

            float farCrossL = readDelay(delayL, readCross, size);
            float farCrossR = readDelay(delayR, readCross, size);
            float farReflectL = readDelay(delayL, readReflect, size);
            float farReflectR = readDelay(delayR, readReflect, size);
            delayL[w] = hiL;
            delayR[w] = hiR;
            w = w + 1 == size ? 0 : w + 1;
            if (spinning) {
                ph += increment;
                if (ph > 2d * Math.PI) ph -= 2d * Math.PI;
            }

            clL += aCross * (farCrossR - clL);
            clR += aCross * (farCrossL - clR);
            rlL += aReflect * (farReflectR - rlL);
            rlR += aReflect * (farReflectL - rlR);

            // 电平自适应补偿：加宽多出来的功率 + 空间项功率，按实测能量补掉
            float total = m2 + s2 + 1e-9f;
            float extra = (sideGain * sideGain - 1f) * s2 + gatedMid * gatedMid * 0.5f * m2;
            float k = extra / total;
            float spatialPower = (gatedCross * gatedCross + gatedReflect * gatedReflect) * 0.5f;
            float target = OUTPUT_TRIM / (float) Math.sqrt(1d + Math.max(0f, k) + 2d * spatialPower);
            g += (target - g) * aGain;

            float lowMid = (loLowL + loLowR) * 0.5f;
            float outLowL = loLowL + (lowMid - loLowL) * bass;
            float outLowR = loLowR + (lowMid - loLowR) * bass;
            float sway = mid * pan * gatedMid;

            left[i] = (outLowL + mid + sway + side * sideGain + gatedCross * clL + gatedReflect * rlL) * g;
            right[i] = (outLowR + mid - sway - side * sideGain + gatedCross * clR + gatedReflect * rlR) * g;
        }

        loL = loLowL;
        loR = loLowR;
        crossLpL = clL;
        crossLpR = clR;
        reflectLpL = rlL;
        reflectLpR = rlR;
        midEnergy = m2;
        sideEnergy = s2;
        gain = g;
        phase = ph;
        write = w;
    }

    private static float readDelay(float[] buffer, float position, int size) {
        int first = (int) position;
        if (first >= size) first -= size;
        int second = first + 1 == size ? 0 : first + 1;
        float fraction = position - (float) first;
        return buffer[first] + (buffer[second] - buffer[first]) * fraction;
    }

    private void updateTargets() {
        if (!dirty) return;
        dirty = false;
        float s = strength;
        switch (mode) {
            case MODE_WIDE:
                targetWide = 0.30f + 0.30f * s;
                targetCross = 0.10f + 0.06f * s;
                targetReflect = 0f;
                targetRotate = 0f;
                targetBass = 0.30f;
                break;
            case MODE_IMMERSE:
                targetWide = 0.38f + 0.32f * s;
                targetCross = 0.12f + 0.06f * s;
                targetReflect = 0.10f + 0.06f * s;
                targetRotate = 0.25f * s;
                targetBass = 0.55f;
                break;
            case MODE_ROTATE:
                targetWide = 0.30f + 0.30f * s;
                targetCross = 0.10f + 0.06f * s;
                targetReflect = 0.08f + 0.05f * s;
                targetRotate = 0.60f + 0.40f * s;
                targetBass = 0.55f;
                break;
            case MODE_VIPER:
                targetWide = 0.45f + 0.35f * s;
                targetCross = 0.13f + 0.05f * s;
                targetReflect = 0.12f + 0.06f * s;
                targetRotate = 0f;
                targetBass = 0.75f;
                break;
            default:
                targetWide = targetCross = targetReflect = targetRotate = targetBass = 0f;
                break;
        }
    }

    private void smooth() {
        float c = smoothCoef;
        if (c <= 0f || c >= 1f) c = 0.125f;
        wide += (targetWide - wide) * c;
        cross += (targetCross - cross) * c;
        reflect += (targetReflect - reflect) * c;
        rotate += (targetRotate - rotate) * c;
        bassMono += (targetBass - bassMono) * c;
        // 空间项门控：side/mid 能量比太低（单声道素材）就直接关掉，避免梳状染色
        float total = midEnergy + sideEnergy + 1e-9f;
        float ratio = sideEnergy / total;
        float target = ratio <= GATE_OFF_RATIO ? 0f : ratio >= GATE_ON_RATIO ? 1f : (ratio - GATE_OFF_RATIO) / (GATE_ON_RATIO - GATE_OFF_RATIO);
        gate += (target - gate) * 0.15f;
    }
}
