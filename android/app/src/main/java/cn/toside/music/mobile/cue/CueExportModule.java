package cn.toside.music.mobile.cue;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * 极客功能二：CUE 真切片导出。
 * MediaExtractor 取音轨 → MediaCodec 解码成 PCM → 按 INDEX 时间轴裁好后写 WAV。
 * WAV 是无损 PCM，能保证"切片 == 原轨那一小段"；真 FLAC 切片需要 vendor 一套 libFLAC 编码器，
 * 那是后面一步的事，这里先把无损切片跑通。
 */
public final class CueExportModule extends ReactContextBaseJavaModule {
    private static final String NAME = "CueExportModule";
    private static final int HEADER_SIZE = 44;

    public CueExportModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return NAME;
    }

    /** 探测文件能否被系统解码（CUE 列表里先标出来，免得导出到一半才失败） */
    @ReactMethod
    public void probe(String inputPath, Promise promise) {
        new Thread(() -> {
            MediaExtractor extractor = new MediaExtractor();
            try {
                extractor.setDataSource(inputPath);
                for (int i = 0; i < extractor.getTrackCount(); i++) {
                    MediaFormat format = extractor.getTrackFormat(i);
                    String mime = format.getString(MediaFormat.KEY_MIME);
                    if (mime == null || !mime.startsWith("audio/")) continue;
                    WritableMap map = Arguments.createMap();
                    map.putBoolean("supported", true);
                    map.putString("mime", mime);
                    map.putInt("sampleRate", format.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? format.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 0);
                    map.putInt("channels", format.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 0);
                    long duration = format.containsKey(MediaFormat.KEY_DURATION) ? format.getLong(MediaFormat.KEY_DURATION) : 0;
                    map.putDouble("duration", duration / 1_000_000d);
                    promise.resolve(map);
                    return;
                }
                WritableMap map = Arguments.createMap();
                map.putBoolean("supported", false);
                map.putString("error", "没有音频轨道");
                promise.resolve(map);
            } catch (Throwable error) {
                WritableMap map = Arguments.createMap();
                map.putBoolean("supported", false);
                map.putString("error", String.valueOf(error.getMessage()));
                promise.resolve(map);
            } finally {
                try { extractor.release(); } catch (Throwable ignored) {}
            }
        }, "lx-cue-probe").start();
    }

    /**
     * 把 [startSec, endSec) 这一段解码出来写成 16bit PCM 的 WAV。
     * 返回 { path, bytes, seconds }。
     */
    @ReactMethod
    public void exportTrack(String inputPath, double startSec, double endSec, String outputPath, Promise promise) {
        new Thread(() -> {
            try {
                long bytes = export(inputPath, startSec, endSec, outputPath);
                WritableMap map = Arguments.createMap();
                map.putString("path", outputPath);
                map.putDouble("bytes", bytes);
                map.putDouble("seconds", Math.max(0, endSec - startSec));
                promise.resolve(map);
            } catch (Throwable error) {
                promise.reject("cue_export_failed", String.valueOf(error.getMessage()), error);
            }
        }, "lx-cue-export").start();
    }

    private static long export(String inputPath, double startSec, double endSec, String outputPath) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        RandomAccessFile out = null;
        try {
            extractor.setDataSource(inputPath);
            int audioTrack = -1;
            MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat candidate = extractor.getTrackFormat(i);
                String mime = candidate.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    audioTrack = i;
                    format = candidate;
                    break;
                }
            }
            if (audioTrack < 0 || format == null) throw new IOException("没有找到音频轨道");
            extractor.selectTrack(audioTrack);

            final String mime = format.getString(MediaFormat.KEY_MIME);
            int sampleRate = format.containsKey(MediaFormat.KEY_SAMPLE_RATE) ? format.getInteger(MediaFormat.KEY_SAMPLE_RATE) : 44100;
            int channels = format.containsKey(MediaFormat.KEY_CHANNEL_COUNT) ? format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) : 2;
            int pcmEncoding = format.containsKey(MediaFormat.KEY_PCM_ENCODING)
                ? format.getInteger(MediaFormat.KEY_PCM_ENCODING) : AudioFormat.ENCODING_PCM_16BIT;
            if (sampleRate <= 0) sampleRate = 44100;
            if (channels <= 0) channels = 2;

            final long startUs = Math.max(0L, (long) (startSec * 1_000_000d));
            final long endUs = endSec > startSec ? (long) (endSec * 1_000_000d) : Long.MAX_VALUE / 4;
            extractor.seekTo(startUs, MediaExtractor.SEEK_TO_CLOSEST_SYNC);

            codec = MediaCodec.createDecoderByType(mime);
            codec.configure(format, null, null, 0);
            codec.start();

            final File target = new File(outputPath);
            final File parent = target.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("无法创建目录: " + parent);
            out = new RandomAccessFile(target, "rw");
            out.setLength(0);
            writeHeader(out, 0, channels, sampleRate);

            final long startFrame = Math.round(startUs * sampleRate / 1_000_000d);
            final long endFrame = Math.round(endUs * sampleRate / 1_000_000d);
            final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean outputDone = false;
            long dataBytes = 0;
            byte[] scratch = new byte[1024 * 1024];
            int idleLoops = 0;

            while (!outputDone) {
                // 解码器长时间不给数据（坏文件/不支持的编码）：别把线程永远挂在这
                if (++idleLoops > 3000) throw new IOException("解码超时（文件损坏或编码不支持）");
                if (!inputDone) {
                    final int inIndex = codec.dequeueInputBuffer(10_000);
                    if (inIndex >= 0) {
                        final ByteBuffer inBuffer = codec.getInputBuffer(inIndex);
                        int size = inBuffer == null ? -1 : extractor.readSampleData(inBuffer, 0);
                        final long sampleTime = extractor.getSampleTime();
                        if (size < 0 || sampleTime > endUs) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(inIndex, 0, size, sampleTime, 0);
                            extractor.advance();
                        }
                    }
                }
                final int outIndex = codec.dequeueOutputBuffer(info, 10_000);
                if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) continue;
                idleLoops = 0;
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) continue;
                if (outIndex == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED) continue;
                if (outIndex < 0) continue;
                ByteBuffer buffer = codec.getOutputBuffer(outIndex);
                if (buffer != null && info.size > 0 && info.presentationTimeUs < endUs) {
                    buffer.position(info.offset);
                    buffer.limit(info.offset + info.size);
                    final long bufferStartFrame = Math.round(info.presentationTimeUs * sampleRate / 1_000_000d);
                    final int frameCount = convert(buffer, pcmEncoding, channels, scratch);
                    final long firstFrame = Math.max(0L, startFrame - bufferStartFrame);
                    final long lastFrame = Math.min(frameCount, endFrame - bufferStartFrame);
                    if (lastFrame > firstFrame) {
                        final int frameBytes = channels * 2;
                        final long offset = firstFrame * frameBytes;
                        final long length = (lastFrame - firstFrame) * frameBytes;
                        // 防御：极端情况下解码块大于暂存区就跳过，绝不越界写
                        if (offset + length <= scratch.length) {
                            out.seek(HEADER_SIZE + dataBytes);
                            out.write(scratch, (int) offset, (int) length);
                            dataBytes += length;
                        }
                    }
                }
                codec.releaseOutputBuffer(outIndex, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
            }
            writeHeader(out, dataBytes, channels, sampleRate);
            return dataBytes;
        } finally {
            if (out != null) try { out.close(); } catch (Throwable ignored) {}
            if (codec != null) {
                try { codec.stop(); } catch (Throwable ignored) {}
                try { codec.release(); } catch (Throwable ignored) {}
            }
            try { extractor.release(); } catch (Throwable ignored) {}
        }
    }

    /**
     * 解码输出统一转成 16bit PCM 交织数据，返回帧数。
     * MediaCodec 的 PCM 编码可能是 16bit / float / 8bit / 24bit / 32bit，这里全覆盖。
     */
    private static int convert(ByteBuffer buffer, int encoding, int channels, byte[] scratch) {
        final int frameBytes16 = channels * 2;
        buffer.order(ByteOrder.LITTLE_ENDIAN);
        final int remaining = buffer.remaining();
        int frames = 0;
        int out = 0;
        switch (encoding) {
            case AudioFormat.ENCODING_PCM_FLOAT: {
                final int count = remaining / 4;
                frames = count / channels;
                for (int i = 0; i < frames * channels; i++) {
                    float value = buffer.getFloat();
                    if (!(value > -1f)) value = value > 0f ? 1f : -1f;
                    else if (value > 1f) value = 1f;
                    final int sample = (int) (value * 32767f + (value >= 0f ? 0.5f : -0.5f));
                    scratch[out++] = (byte) (sample & 0xFF);
                    scratch[out++] = (byte) ((sample >> 8) & 0xFF);
                }
                break;
            }
            case AudioFormat.ENCODING_PCM_8BIT: {
                frames = remaining / channels;
                for (int i = 0; i < frames * channels; i++) {
                    final int sample = ((buffer.get() & 0xFF) - 128) << 8;
                    scratch[out++] = (byte) (sample & 0xFF);
                    scratch[out++] = (byte) ((sample >> 8) & 0xFF);
                }
                break;
            }
            case AudioFormat.ENCODING_PCM_24BIT_PACKED:
            case AudioFormat.ENCODING_PCM_32BIT: {
                final int bytesPerSample = encoding == AudioFormat.ENCODING_PCM_24BIT_PACKED ? 3 : 4;
                frames = remaining / (bytesPerSample * channels);
                for (int i = 0; i < frames * channels; i++) {
                    int sample;
                    if (bytesPerSample == 3) {
                        final int b0 = buffer.get() & 0xFF;
                        final int b1 = buffer.get() & 0xFF;
                        final int b2 = buffer.get();
                        sample = (b2 << 16) | (b1 << 8) | b0;
                        sample >>= 8;
                    } else {
                        sample = buffer.getInt() >> 16;
                    }
                    scratch[out++] = (byte) (sample & 0xFF);
                    scratch[out++] = (byte) ((sample >> 8) & 0xFF);
                }
                break;
            }
            default: {
                frames = remaining / frameBytes16;
                final int bytes = frames * frameBytes16;
                buffer.get(scratch, 0, bytes);
                out = bytes;
                break;
            }
        }
        return frames;
    }

    private static void writeHeader(RandomAccessFile out, long dataBytes, int channels, int sampleRate) throws IOException {
        final int blockAlign = channels * 2;
        final long byteRate = (long) sampleRate * blockAlign;
        final ByteBuffer header = ByteBuffer.allocate(HEADER_SIZE).order(ByteOrder.LITTLE_ENDIAN);
        header.put(new byte[] {'R', 'I', 'F', 'F'});
        header.putInt((int) Math.min(Integer.MAX_VALUE, 36 + dataBytes));
        header.put(new byte[] {'W', 'A', 'V', 'E'});
        header.put(new byte[] {'f', 'm', 't', ' '});
        header.putInt(16);
        header.putShort((short) 1);
        header.putShort((short) channels);
        header.putInt(sampleRate);
        header.putInt((int) Math.min(Integer.MAX_VALUE, byteRate));
        header.putShort((short) blockAlign);
        header.putShort((short) 16);
        header.put(new byte[] {'d', 'a', 't', 'a'});
        header.putInt((int) Math.min(Integer.MAX_VALUE, dataBytes));
        out.seek(0);
        out.write(header.array(), 0, HEADER_SIZE);
    }
}
