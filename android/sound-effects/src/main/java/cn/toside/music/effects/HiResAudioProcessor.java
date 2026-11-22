package cn.toside.music.effects;

import androidx.media3.common.C;
import androidx.media3.common.audio.BaseAudioProcessor;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * 接在音效处理器之后：把 PCM16 用 C++ 多相 sinc 插值升到 96/192kHz，
 * 输出格式采样率一变，DefaultAudioSink 就会用高采样率开 AudioTrack。
 *
 * Aurora-15「冷链防抖」：
 * 1) 升频建不出来（设备不支持 / nativeCreate 失败）→ 同一个 onConfigure 里顺着降级链往下走一档，
 *    绝不把「按 192kHz 声明、实际塞 44.1kHz 帧」的错配数据流丢给 AudioSink（那是爆音+抽搐的来源）；
 * 2) 渲染抛异常 / 连续慢块（音频线程跟不上）→ 静默降级（192→96→48），本块用等长静音垫住，
 *    后台重建管线；全程不弹错、不抛异常，音频线程永远不崩；
 * 3) 降级后由 HiRes 的冷链冷却把看门狗静默 3 秒，避免它把「正在切采样率」当成卡死去踹一脚。
 *
 * 任何异常都退回原样透出 —— 音频线程崩掉就是"UI 在播却没声音"，这条底线不变。
 */
public final class HiResAudioProcessor extends BaseAudioProcessor {
    /** 单块渲染耗时超过这块音频本身时长的倍数就算「慢块」 */
    private static final int SLOW_FACTOR = 2;
    /** 连续慢块到这么多块就静默降档 */
    private static final int SLOW_BLOCKS_TO_DEGRADE = 3;
    private static final int MIN_PREALLOC_FRAMES = 4096;
    private static final int MAX_PREALLOC_FRAMES = 16384;

    private long handle;
    private int channels;
    private int inRate;
    private int outRate;
    private int bufferMs;
    private int slowBlocks;
    private short[] pcmIn = new short[0];
    private short[] pcmOut = new short[0];

    @Override
    protected AudioFormat onConfigure(AudioFormat format) throws UnhandledAudioFormatException {
        if (format.encoding != C.ENCODING_PCM_16BIT) throw new UnhandledAudioFormatException(format);
        close();
        final long created = HiRes.beginResample(format.sampleRate, format.channelCount);
        final int rate = created == 0 ? 0 : HiRes.activeOutputRate();
        if (created == 0 || rate <= format.sampleRate) {
            if (created != 0) HiRes.destroy(created);
            HiRes.notePassthrough(format.sampleRate);
            return format;
        }
        handle = created;
        channels = format.channelCount;
        inRate = format.sampleRate;
        outRate = rate;
        bufferMs = HiRes.bufferMs(created);
        slowBlocks = 0;
        preallocate();
        HiRes.noteConfigured();
        SoundEffects.diag("HIRES_CONFIG in=" + inRate + " out=" + outRate + " bufferMs=" + bufferMs
            + " planFrames=" + HiRes.planFrames(created) + " target=" + HiRes.target()
            + " effective=" + HiRes.effectiveTarget() + " degrades=" + HiRes.degradeCount());
        return new AudioFormat(rate, format.channelCount, C.ENCODING_PCM_16BIT);
    }

    /** 按该档位的缓冲计划预分配，音频线程后续不再 new short[] */
    private void preallocate() {
        int frames = HiRes.planFrames(handle);
        if (frames < MIN_PREALLOC_FRAMES) frames = MIN_PREALLOC_FRAMES;
        if (frames > MAX_PREALLOC_FRAMES) frames = MAX_PREALLOC_FRAMES;
        final int outFrames = (int) (((long) frames * outRate) / inRate) + 2;
        pcmIn = new short[frames * channels];
        pcmOut = new short[Math.max(2, outFrames * channels)];
    }

    @Override
    public void queueInput(ByteBuffer buffer) {
        if (!buffer.hasRemaining()) return;
        final int channelCount = channels > 0 ? channels : inputAudioFormat.channelCount;
        if (handle == 0 || channelCount < 1 || inRate <= 0) {
            if (HiRes.switchingPending()) {
                // 正在切采样率：用等长静音垫住，绝不把源采样率的帧硬塞进高采样率的流
                emitSilence(buffer, channelCount);
                return;
            }
            passthrough(buffer);
            return;
        }
        buffer.order(ByteOrder.LITTLE_ENDIAN);
        final int frameSize = channelCount * 2;
        final int frames = buffer.remaining() / frameSize;
        if (frames <= 0) {
            passthrough(buffer);
            return;
        }
        final int samples = frames * channelCount;
        if (pcmIn.length < samples) pcmIn = new short[samples];
        final int capacity = Math.max(2, (int) (((long) frames * outRate) / inRate) + 2) * channelCount;
        if (pcmOut.length < capacity) pcmOut = new short[capacity];
        for (int i = 0; i < samples; i++) pcmIn[i] = buffer.getShort();

        int produced = 0;
        boolean failed = false;
        final long startedAt = System.nanoTime();
        try {
            produced = HiRes.render(handle, pcmIn, frames, pcmOut);
        } catch (Throwable error) {
            failed = true;
            SoundEffects.noteError("hires render: " + error);
        }
        final long costUs = (System.nanoTime() - startedAt) / 1000L;

        if (failed) {
            // 静默降级：关句柄 → 走降级链 → 后台重建；本块静音垫住，不弹错、不抛异常
            closeHandle();
            HiRes.requestDegrade("render");
            emitSilence(frames, channelCount);
            return;
        }
        if (produced <= 0) {
            // 句柄还活着但输出不了（块太小凑不满抽头）：交空缓冲，绝不用源采样率的帧凑数
            replaceOutputBuffer(0);
            return;
        }

        // 慢块判定：一块音频本该在 blockUs 内算完，连续超时说明音频线程撑不住这个采样率
        final long blockUs = Math.max(1L, (long) frames * 1000000L / inRate);
        if (costUs > blockUs * SLOW_FACTOR) {
            slowBlocks++;
            if (slowBlocks >= SLOW_BLOCKS_TO_DEGRADE) {
                slowBlocks = 0;
                SoundEffects.diag("HIRES_SLOW cost=" + costUs + "us block=" + blockUs + "us rate=" + outRate);
                HiRes.requestDegrade("slow");
            }
        } else {
            slowBlocks = 0;
        }

        HiRes.record(produced);
        final ByteBuffer output = replaceOutputBuffer(produced * frameSize).order(ByteOrder.LITTLE_ENDIAN);
        final int total = produced * channelCount;
        for (int i = 0; i < total; i++) output.putShort(pcmOut[i]);
        output.flip();
    }

    private void passthrough(ByteBuffer input) {
        final ByteBuffer output = replaceOutputBuffer(input.remaining()).order(ByteOrder.LITTLE_ENDIAN);
        output.put(input);
        output.flip();
    }

    /** 输出等长静音并消费掉整块输入（AudioPipeline 要求输入必须被消费干净） */
    private void emitSilence(ByteBuffer input, int channelCount) {
        final int frames = channelCount > 0 ? input.remaining() / (channelCount * 2) : 0;
        input.position(input.limit());
        if (frames <= 0) {
            replaceOutputBuffer(0);
            return;
        }
        emitSilence(frames, Math.max(1, channelCount));
    }

    private void emitSilence(int frames, int channelCount) {
        final ByteBuffer output = replaceOutputBuffer(frames * channelCount * 2).order(ByteOrder.LITTLE_ENDIAN);
        final int samples = frames * channelCount;
        for (int i = 0; i < samples; i++) output.putShort((short) 0);
        output.flip();
    }

    @Override
    protected void onFlush() {
        if (handle != 0) HiRes.reset(handle);
    }

    @Override
    protected void onReset() {
        close();
        HiRes.clearStats();
    }

    private void closeHandle() {
        if (handle != 0) {
            HiRes.destroy(handle);
            handle = 0;
        }
    }

    private void close() {
        closeHandle();
        channels = 0;
        inRate = 0;
        outRate = 0;
        bufferMs = 0;
        slowBlocks = 0;
    }
}
