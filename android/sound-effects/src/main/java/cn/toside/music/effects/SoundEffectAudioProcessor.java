package cn.toside.music.effects;

import android.content.Context;
import androidx.media3.common.C;
import androidx.media3.common.audio.BaseAudioProcessor;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;

public final class SoundEffectAudioProcessor extends BaseAudioProcessor {
    private final Context context;
    private float[][] input = new float[0][];
    private final float[][] wet = new float[2][PartitionedConvolver.BLOCK];
    private float[][] mix = new float[0][];
    // HRTF 之前的干信号备份：HRTF 出问题（NaN/静默）时整块回退，避免爆音或没声音
    private float[][] mixBackup = new float[0][];
    private int position;
    private int channels;
    private int rate;
    private int remainingEndFrames;
    private boolean hadInput;
    private boolean eosQueued;
    private BiquadEqualizer equalizer;
    // Aurora-27：C++ 31 段内核。句柄为 0 时退回上面的 Java 十段实现，绝不因为原生不可用就没有均衡
    private long eqHandle;
    private int eqSignature;
    private int eqStatTick;
    // Aurora-29：模拟黑胶 / 胆机。句柄为 0 时整条模块直通，绝不失声
    private long vinylHandle;
    private int vinylSignature;
    private int vinylStatTick;
    private final float[] eqGains10 = new float[10];
    private final float[] eqGains31 = new float[31];
    private final SurroundProcessor surround = new SurroundProcessor();
    private SoundEffects.Prepared active;
    private SoundEffects.Prepared endImpulse;
    private double dryGain = 1;
    private double wetGain;
    private double limiterGain = 1;
    private double[] dcIn = new double[0];
    private double[] dcOut = new double[0];
    private double dcCoef = 0.999;
    private static final double LIMIT_THRESHOLD = 0.9;

    public SoundEffectAudioProcessor(Context context) {
        this.context = context.getApplicationContext();
    }

    @Override
    protected AudioFormat onConfigure(AudioFormat format) throws UnhandledAudioFormatException {
        if (format.encoding != C.ENCODING_PCM_16BIT || format.channelCount < 1 || format.sampleRate < 1) {
            throw new UnhandledAudioFormatException(format);
        }
        ensureBuffers(format.channelCount, format.sampleRate);
        return format;
    }

    /**
     * 分配/重建所有按格式绑定的缓冲。onConfigure 与 onFlush 都会调用：
     * 之前只在 onFlush 分配，一旦 ExoPlayer 走了 configure→queueInput 而不是 configure→flush，
     * 音频线程就会在 input[ch][position] 上越界抛异常 —— 表现正是"UI 在播但完全没声音"。
     */
    private void ensureBuffers(int channelCount, int sampleRate) {
        if (channelCount < 1 || sampleRate < 1) return;
        if (channels == channelCount && rate == sampleRate && input.length == channelCount
            && mix.length == channelCount && mixBackup.length == channelCount && equalizer != null) return;
        channels = channelCount;
        rate = sampleRate;
        input = new float[channelCount][PartitionedConvolver.BLOCK];
        mix = new float[channelCount][PartitionedConvolver.BLOCK];
        mixBackup = new float[channelCount][PartitionedConvolver.BLOCK];
        dcIn = new double[channelCount];
        dcOut = new double[channelCount];
        dcCoef = 1d - 2d * Math.PI * 8d / sampleRate;
        if (dcCoef < 0.9) dcCoef = 0.9;
        equalizer = new BiquadEqualizer(sampleRate, channelCount);
        // 采样率/声道数变了：重建原生内核（只在 configure/flush 里做，音频热路径不分配内存）
        releaseEq();
        eqHandle = Eq31.create(sampleRate, channelCount);
        eqSignature = 0;
        eqStatTick = 0;
        if (eqHandle == 0 && Eq31.available()) SoundEffects.noteError("eq31 create failed");
        // 味精模块：同样只在 configure/flush 里重建，音频热路径不分配内存
        releaseVinyl();
        vinylHandle = Vinyl.create(sampleRate, channelCount);
        vinylSignature = 0;
        vinylStatTick = 0;
        if (vinylHandle == 0 && Vinyl.available()) SoundEffects.noteError("vinyl create failed");
        position = 0;
    }

    @Override
    public void queueInput(ByteBuffer buffer) {
        if (!buffer.hasRemaining()) return;
        if (channels < 1 || input.length < channels) {
            // 还没配置好：原样透出，绝不让音频线程崩掉（崩掉就是"UI 在播却没声音"）
            buffer.order(ByteOrder.LITTLE_ENDIAN);
            ByteBuffer passthrough = replaceOutputBuffer(buffer.remaining()).order(ByteOrder.LITTLE_ENDIAN);
            passthrough.put(buffer);
            passthrough.flip();
            SoundEffects.noteError("queueInput before configure");
            return;
        }
        buffer.order(ByteOrder.LITTLE_ENDIAN);
        int frames = buffer.remaining() / (channels * 2);
        if (frames > 0) hadInput = true;
        int outputFrames = ((position + frames) / PartitionedConvolver.BLOCK) * PartitionedConvolver.BLOCK;
        ByteBuffer output = replaceOutputBuffer(outputFrames * channels * 2).order(ByteOrder.LITTLE_ENDIAN);
        while (buffer.remaining() >= channels * 2) {
            for (int ch = 0; ch < channels; ch++) input[ch][position] = buffer.getShort() / 32768f;
            position++;
            if (position == PartitionedConvolver.BLOCK) {
                process(output, position);
                position = 0;
            }
        }
        output.flip();
    }

    private SoundEffects.Prepared currentImpulse() {
        SoundEffects.Prepared prepared = SoundEffects.prepared();
        return prepared != null && prepared.source.equals(SoundEffects.settings().source) && prepared.rate == rate ? prepared : null;
    }

    private void process(ByteBuffer output, int frames) {
        try {
            processInternal(output, frames);
        } catch (Throwable error) {
            // 音频线程抛异常 = 这一段彻底没声；这里兜住并原样透出，保证不断流
            SoundEffects.noteError("process: " + error);
            passthrough(output, frames);
        }
    }

    /** 出错时的保险：把输入原样写回去（读不到的补 0），保证有声音且不崩 */
    private void passthrough(ByteBuffer output, int frames) {
        try {
            output.clear();
            int chCount = Math.max(1, channels);
            for (int i = 0; i < frames; i++) {
                for (int ch = 0; ch < chCount; ch++) {
                    float value = (ch < input.length && i < input[ch].length) ? input[ch][i] : 0f;
                    output.putShort(toPcm(value));
                }
            }
            output.flip();
        } catch (Throwable ignored) {
        }
    }

    private void processInternal(ByteBuffer output, int frames) {
        EffectSettings settings = SoundEffects.settings();
        SoundEffects.record(frames, channels, rate, settings);
        // 可视化取数：只用原始 PCM（EQ/环绕之前），且只在完整块上取样
        if (frames == PartitionedConvolver.BLOCK) VisualizerTap.feed(input, channels, frames);
        HapticBass.feed(input, channels, frames);
        SoundEffects.Prepared prepared = currentImpulse();
        if (prepared != active) {
            active = prepared;
            if (active != null) active.engine.reset();
            wetGain = 0;
        }
        if (!settings.active()) {
            equalizer.set(EffectSettings.OFF, true);
            equalizer.reset();
            if (eqHandle != 0) Eq31.reset(eqHandle);
            if (vinylHandle != 0) Vinyl.reset(vinylHandle);
            surround.reset();
            dryGain = limiterGain = 1;
            wetGain = 0;
            Arrays.fill(dcIn, 0);
            Arrays.fill(dcOut, 0);
            for (int i = 0; i < frames; i++) for (int ch = 0; ch < channels; ch++) output.putShort(toPcm(input[ch][i]));
            return;
        }
        applyEqualizer(settings, frames);
        surround.set(settings.surroundMode, (float) settings.surroundStrength, (float) settings.surroundSpeed);
        surround.process(input, channels, frames);
        if (active != null) active.engine.process(input[0], input[Math.min(1, channels - 1)], wet[0], wet[1]);
        double targetDry = active == null ? 1 : settings.dry;
        double targetWet = active == null ? 0 : settings.wet;
        double smoothing = 1 - Math.exp(-1.0 / (rate * 0.015));
        // 限幅：起限 0.9，快攻(0.3ms)慢放(120ms)，只在真的快爆表时动，正常音乐不动它
        double attack = 1 - Math.exp(-1.0 / (rate * 0.0003));
        double release = 1 - Math.exp(-1.0 / (rate * 0.120));
        for (int i = 0; i < frames; i++) {
            dryGain += (targetDry - dryGain) * smoothing;
            wetGain += (targetWet - wetGain) * smoothing;
            for (int ch = 0; ch < channels; ch++) {
                double value = input[ch][i];
                if (ch < 2) {
                    double effect = channels == 1 ? (wet[0][i] + wet[1][i]) * 0.5 : wet[ch][i];
                    value = value * dryGain + (active == null ? 0 : effect * wetGain);
                }
                // 直流阻断（一阶高通），同时把 NaN/Inf/爆表值挡掉
                if (!(value > -16d && value < 16d)) value = 0d;
                double highpassed = value - dcIn[ch] + dcCoef * dcOut[ch];
                dcIn[ch] = value;
                dcOut[ch] = highpassed;
                mix[ch][i] = (float) highpassed;
            }
        }
        // Aurora-29：味精模块（胆机 + 底噪 + 肉摇）—— 混响与直流阻断之后、头追与限幅之前
        applyVinyl(settings, frames);
        // 头追双耳渲染：必须放在干湿混音之后，否则双耳耳信号会被当成音箱再渲染一次
        BinauralStage binaural = channels == 2 ? BinauralStage.current() : null;
        if (binaural != null) {
            System.arraycopy(mix[0], 0, mixBackup[0], 0, frames);
            System.arraycopy(mix[1], 0, mixBackup[1], 0, frames);
            boolean ok = binaural.process(mix[0], mix[1], frames);
            if (!ok || (isSilent(mix[0], frames) && !isSilent(mixBackup[0], frames))) {
                // 渲染失败或整块变静音：回退到未处理信号（暂停恢复无声音的兜底）
                System.arraycopy(mixBackup[0], 0, mix[0], 0, frames);
                System.arraycopy(mixBackup[1], 0, mix[1], 0, frames);
                binaural.reset();
            }
        }
        // 限幅 + 输出
        for (int i = 0; i < frames; i++) {
            double peak = 0;
            for (int ch = 0; ch < channels; ch++) {
                double magnitude = Math.abs(mix[ch][i]);
                if (magnitude > peak) peak = magnitude;
            }
            double target = peak > LIMIT_THRESHOLD ? LIMIT_THRESHOLD / peak : 1;
            limiterGain = target < limiterGain ? limiterGain + (target - limiterGain) * attack : limiterGain + (target - limiterGain) * release;
            for (int ch = 0; ch < channels; ch++) output.putShort(toPcm(softClip(mix[ch][i] * limiterGain)));
        }
    }

    private static boolean isSilent(float[] buffer, int frames) {
        for (int i = 0; i < frames; i++) {
            float value = buffer[i];
            if (!(value > -1e-4f && value < 1e-4f)) return false;
        }
        return true;
    }

    /** 0.8 以下完全线性，0.8~1.0 之间平滑压到 1.0，避免硬削产生的刺啦/电流声 */
    private static double softClip(double value) {
        double magnitude = Math.abs(value);
        if (magnitude <= 0.8) return value;
        double shaped = 0.8 + 0.2 * (1d - Math.exp(-(magnitude - 0.8) / 0.2));
        return value < 0 ? -shaped : shaped;
    }

    private static short toPcm(double value) {
        return (short) Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
    }

    @Override
    protected void onQueueEndOfStream() {
        if (eosQueued) return;
        eosQueued = true;
        endImpulse = currentImpulse();
        remainingEndFrames = position + (hadInput && endImpulse != null ? endImpulse.engine.tailFrames() : 0);
        if (remainingEndFrames > 0) writeEndBlock();
    }

    private void writeEndBlock() {
        for (float[] channel : input) Arrays.fill(channel, position, channel.length, 0);
        int frames = Math.min(PartitionedConvolver.BLOCK, remainingEndFrames);
        ByteBuffer output = replaceOutputBuffer(frames * channels * 2).order(ByteOrder.LITTLE_ENDIAN);
        process(output, frames);
        position = 0;
        remainingEndFrames -= frames;
        output.flip();
    }

    @Override
    public ByteBuffer getOutput() {
        ByteBuffer output = super.getOutput();
        if (output.hasRemaining() || remainingEndFrames == 0) return output;
        if (endImpulse != null && endImpulse != currentImpulse()) {
            remainingEndFrames = 0;
            return output;
        }
        writeEndBlock();
        return super.getOutput();
    }

    @Override
    public boolean isEnded() {
        return super.isEnded() && remainingEndFrames == 0;
    }

    @Override
    protected void onFlush() {
        position = remainingEndFrames = 0;
        hadInput = eosQueued = false;
        endImpulse = null;
        if (inputAudioFormat != AudioFormat.NOT_SET) {
            ensureBuffers(inputAudioFormat.channelCount, inputAudioFormat.sampleRate);
            equalizer.set(SoundEffects.settings(), true);
            equalizer.reset();
            if (eqHandle != 0) {
                Eq31.reset(eqHandle);
                eqSignature = 0;
            }
            if (vinylHandle != 0) {
                Vinyl.reset(vinylHandle);
                vinylSignature = 0;
            }
            surround.setSampleRate(rate);
            surround.reset();
            SoundEffects.setSampleRate(context, rate);
        }
        for (float[] channel : input) Arrays.fill(channel, 0);
        if (active != null) active.engine.reset();
        BinauralStage stage = BinauralStage.current();
        if (stage != null) stage.reset();
        dryGain = limiterGain = 1;
        wetGain = 0;
    }

    @Override
    protected void onReset() {
        position = remainingEndFrames = 0;
        hadInput = eosQueued = false;
        active = endImpulse = null;
        equalizer = null;
        releaseEq();
        releaseVinyl();
        surround.reset();
        input = new float[0][];
        mix = new float[0][];
        dcIn = new double[0];
        dcOut = new double[0];
        channels = rate = 0;
    }

    /** 均衡：优先 C++ 31 段内核，句柄不可用时退回 Java 十段实现（降级但不失声） */
    private void applyEqualizer(EffectSettings settings, int frames) {
        if (eqHandle != 0) {
            final boolean on = settings.equalizer;
            final int mode = settings.eqMode;
            for (int i = 0; i < eqGains10.length; i++) eqGains10[i] = (float) settings.gains[i];
            for (int i = 0; i < eqGains31.length; i++) eqGains31[i] = (float) settings.gains31[i];
            final int signature = eqSignature(mode, on, settings.eqHeadroom);
            if (signature != eqSignature) {
                eqSignature = signature;
                Eq31.setParams(eqHandle, eqGains10, eqGains31, mode, on, settings.eqHeadroom);
            }
            Eq31.process(eqHandle, input, frames, channels);
            if (++eqStatTick >= 96) {
                eqStatTick = 0;
                SoundEffects.noteEq(true, mode, Eq31.trimDb(eqHandle), Eq31.liveBands(eqHandle));
            }
            return;
        }
        // 降级：31 段配置时按最近频点并到十段，保证还有均衡而不是彻底失效
        if (settings.eqMode == EffectSettings.MODE_31) {
            mapWideToTen(settings.gains31, eqGains10);
            equalizer.setGains(eqGains10, settings.equalizer, false);
        } else {
            equalizer.set(settings, false);
        }
        for (int ch = 0; ch < channels; ch++) {
            for (int i = 0; i < PartitionedConvolver.BLOCK; i++) input[ch][i] = equalizer.process(ch, input[ch][i]);
        }
        if (++eqStatTick >= 96) {
            eqStatTick = 0;
            SoundEffects.noteEq(false, settings.eqMode, 0f, 0);
        }
    }

    /** 31 段 -> 10 段降级映射：每个十段频点取最近的（对数意义上）三分之一倍频程 */
    private static void mapWideToTen(double[] wide, float[] out) {
        for (int band = 0; band < out.length; band++) {
            final double target = EffectSettings.FREQUENCIES[band];
            int best = 0;
            double bestDiff = Double.MAX_VALUE;
            for (int i = 0; i < wide.length; i++) {
                final double diff = Math.abs(Math.log(EffectSettings.FREQUENCIES_31[i] / target));
                if (diff < bestDiff) {
                    bestDiff = diff;
                    best = i;
                }
            }
            out[band] = (float) wide[best];
        }
    }

    private int eqSignature(int mode, boolean on, boolean headroom) {
        int hash = 17;
        hash = hash * 31 + mode;
        hash = hash * 31 + (on ? 1 : 0);
        hash = hash * 31 + (headroom ? 1 : 0);
        for (float value : eqGains10) hash = hash * 31 + Float.floatToIntBits(value);
        for (float value : eqGains31) hash = hash * 31 + Float.floatToIntBits(value);
        return hash;
    }

    /**
     * 味精模块：胆机软削波 + 黑胶底噪 + Wow&Flutter。
     * 参数只在变化时下发（指纹比对），热路径上就是一次 JNI 就地处理。
     */
    private void applyVinyl(EffectSettings settings, int frames) {
        if (vinylHandle == 0) return;
        final float amount = settings.vinylActive() ? (float) settings.vinylAmount : 0f;
        final int signature = vinylSignature(amount, settings);
        if (signature != vinylSignature) {
            vinylSignature = signature;
            Vinyl.setParams(vinylHandle, amount, settings.vinylTube, settings.vinylNoise,
                settings.vinylWow, settings.vinylHiFi, amount > 0f, settings.vinylLpf);
        }
        Vinyl.process(vinylHandle, mix, frames, channels);
        if (++vinylStatTick >= 96) {
            vinylStatTick = 0;
            SoundEffects.noteVinyl(true, amount, Vinyl.osFactor(vinylHandle),
                Vinyl.driveDb(vinylHandle), Vinyl.hissDb(vinylHandle));
        }
    }

    private static int vinylSignature(float amount, EffectSettings settings) {
        int hash = 17;
        hash = hash * 31 + Float.floatToIntBits(amount);
        hash = hash * 31 + (settings.vinylTube ? 1 : 0);
        hash = hash * 31 + (settings.vinylNoise ? 1 : 0);
        hash = hash * 31 + (settings.vinylWow ? 1 : 0);
        hash = hash * 31 + (settings.vinylHiFi ? 1 : 0);
        hash = hash * 31 + (settings.vinylLpf ? 1 : 0);
        return hash;
    }

    private void releaseVinyl() {
        if (vinylHandle != 0) {
            Vinyl.release(vinylHandle);
            vinylHandle = 0;
        }
    }

    private void releaseEq() {
        if (eqHandle != 0) {
            Eq31.release(eqHandle);
            eqHandle = 0;
        }
    }
}

