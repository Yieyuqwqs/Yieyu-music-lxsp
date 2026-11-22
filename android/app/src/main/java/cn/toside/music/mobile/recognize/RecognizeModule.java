package cn.toside.music.mobile.recognize;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Base64;

import androidx.core.content.ContextCompat;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class RecognizeModule extends ReactContextBaseJavaModule {
  private final ReactApplicationContext context;

  RecognizeModule(ReactApplicationContext context) {
    super(context);
    this.context = context;
  }

  @Override
  public String getName() {
    return "RecognizeModule";
  }

  @ReactMethod
  public void record(int durationMs, Promise promise) {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      promise.reject("permission", "RECORD_AUDIO not granted");
      return;
    }
    new Thread(() -> {
      AudioRecord record = null;
      try {
        int sampleRate = 44100;
        int bufferSize = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (bufferSize <= 0) bufferSize = 4096;
        record = new AudioRecord(MediaRecorder.AudioSource.MIC, sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize * 4);
        if (record.getState() != AudioRecord.STATE_INITIALIZED) {
          promise.reject("error", "AudioRecord init failed");
          return;
        }
        int totalBytes = sampleRate * 2 * durationMs / 1000;
        byte[] pcm = new byte[totalBytes];
        record.startRecording();
        int offset = 0;
        while (offset < totalBytes) {
          int read = record.read(pcm, offset, Math.min(bufferSize, totalBytes - offset));
          if (read <= 0) break;
          offset += read;
        }
        try {
          record.stop();
        } catch (Throwable ignored) {
        }
        record.release();
        record = null;
        promise.resolve(Base64.encodeToString(pcm, Base64.NO_WRAP));
      } catch (Throwable e) {
        promise.reject("error", e.getMessage() == null ? "record failed" : e.getMessage());
      } finally {
        if (record != null) {
          try {
            record.release();
          } catch (Throwable ignored) {
          }
        }
      }
    }, "lx-record-audio").start();
  }
}
