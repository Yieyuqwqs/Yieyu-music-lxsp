package cn.toside.music.mobile.download;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class DownloadModule extends ReactContextBaseJavaModule {
  private final ReactApplicationContext context;

  DownloadModule(ReactApplicationContext context) {
    super(context);
    this.context = context;
  }

  @Override
  public String getName() {
    return "DownloadService";
  }

  @ReactMethod
  public void start() {
    DownloadService.start(context);
  }

  @ReactMethod
  public void stop() {
    DownloadService.stop(context);
  }
}
