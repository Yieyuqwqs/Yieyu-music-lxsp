package cn.toside.music.effects;

import android.content.Context;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioTrackBufferSizeProvider;
import androidx.media3.exoplayer.audio.ForwardingAudioSink;

public final class SoundEffectRenderersFactory extends DefaultRenderersFactory {
    public SoundEffectRenderersFactory(Context context) {
        super(context);
    }

    /**
     * 输出缓冲自适应：
     * 默认 PCM 缓冲是 250~750ms（media3 DefaultAudioTrackBufferSizeProvider），对头追来说太拖；
     * 打开头追时压到 120~300ms（比默认 250~750ms 低但不至于欠载），关掉时用默认值。
     * 2026-11-09：60~150ms 太激进，长时间播放偶发 underrun 爆音，已放宽。
     */
    private static final class AdaptiveBufferSizeProvider extends DefaultAudioTrackBufferSizeProvider {
        private final DefaultAudioTrackBufferSizeProvider tight;
        // Aurora-15 冷链防抖：Hi-Res 升频时按目标采样率给硬缓冲 ——
        // 192kHz 给 200~300ms，96kHz 给 150ms。缓冲太薄时 AudioTrack 一抖就 underrun，
        // 表现就是「疯狂抽搐卡顿」，最后 ExoPlayer 直接报音频获取失败。
        private final DefaultAudioTrackBufferSizeProvider hires192;
        private final DefaultAudioTrackBufferSizeProvider hires96;

        AdaptiveBufferSizeProvider() {
            super(new DefaultAudioTrackBufferSizeProvider.Builder());
            tight = new DefaultAudioTrackBufferSizeProvider.Builder()
                .setMinPcmBufferDurationUs(120_000)
                .setMaxPcmBufferDurationUs(300_000)
                .setPcmBufferMultiplicationFactor(3)
                .build();
            hires192 = new DefaultAudioTrackBufferSizeProvider.Builder()
                .setMinPcmBufferDurationUs(200_000)
                .setMaxPcmBufferDurationUs(300_000)
                .setPcmBufferMultiplicationFactor(2)
                .build();
            hires96 = new DefaultAudioTrackBufferSizeProvider.Builder()
                .setMinPcmBufferDurationUs(150_000)
                .setMaxPcmBufferDurationUs(200_000)
                .setPcmBufferMultiplicationFactor(2)
                .build();
        }

        @Override
        public int getBufferSizeInBytes(int minBufferSizeInBytes, int encoding, int outputMode, int pcmFrameSize,
                                        int sampleRate, int bitrate, double maxAudioTrackPlaybackSpeed) {
            // Hi-Res 优先：真实输出采样率越高，硬缓冲越厚（200~300ms / 150ms）
            final int hiresRate = HiRes.activeOutputRate();
            if (hiresRate >= 176400) {
                return hires192.getBufferSizeInBytes(minBufferSizeInBytes, encoding, outputMode, pcmFrameSize,
                    sampleRate, bitrate, maxAudioTrackPlaybackSpeed);
            }
            if (hiresRate >= 88200) {
                return hires96.getBufferSizeInBytes(minBufferSizeInBytes, encoding, outputMode, pcmFrameSize,
                    sampleRate, bitrate, maxAudioTrackPlaybackSpeed);
            }
            if (SoundEffects.settings().headTrack) {
                return tight.getBufferSizeInBytes(minBufferSizeInBytes, encoding, outputMode, pcmFrameSize,
                    sampleRate, bitrate, maxAudioTrackPlaybackSpeed);
            }
            return super.getBufferSizeInBytes(minBufferSizeInBytes, encoding, outputMode, pcmFrameSize,
                sampleRate, bitrate, maxAudioTrackPlaybackSpeed);
        }
    }

    @Override
    protected AudioSink buildAudioSink(Context context, boolean enableFloatOutput, boolean enableAudioTrackPlaybackParams) {
        AudioSink sink = new DefaultAudioSink.Builder(context)
            .setEnableFloatOutput(false)
            .setEnableAudioTrackPlaybackParams(false)
            .setAudioTrackBufferSizeProvider(new AdaptiveBufferSizeProvider())
            .setAudioProcessors(new AudioProcessor[] {new SoundEffectAudioProcessor(context), new HiResAudioProcessor()})
            .build();
        return new ForwardingAudioSink(sink) {
            @Override
            public boolean supportsFormat(Format format) {
                return MimeTypes.AUDIO_RAW.equals(format.sampleMimeType) && super.supportsFormat(format);
            }

            @Override
            public int getFormatSupport(Format format) {
                return MimeTypes.AUDIO_RAW.equals(format.sampleMimeType) ? super.getFormatSupport(format) : SINK_FORMAT_UNSUPPORTED;
            }
        };
    }
}
