package cn.toside.music.mobile;

import com.facebook.react.PackageList;
import com.facebook.react.flipper.ReactNativeFlipper;
import com.reactnativenavigation.NavigationApplication;
import com.facebook.react.ReactNativeHost;
import com.facebook.react.ReactPackage;
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint;
import com.reactnativenavigation.react.NavigationReactNativeHost;
import java.util.List;

import cn.toside.music.mobile.soundEffect.SoundEffectPackage;
import cn.toside.music.mobile.bt.BtAudioPackage;
import cn.toside.music.mobile.cue.CueExportPackage;
import cn.toside.music.mobile.lanshare.LanSharePackage;
import cn.toside.music.mobile.cache.CachePackage;
import cn.toside.music.mobile.download.DownloadPackage;
import cn.toside.music.mobile.recognize.RecognizePackage;
import cn.toside.music.mobile.crypto.CryptoPackage;
import cn.toside.music.mobile.lyric.LyricPackage;
import cn.toside.music.mobile.userApi.UserApiPackage;
import cn.toside.music.mobile.utils.UtilsPackage;
import cn.toside.music.core.CorePackage;

public class MainApplication extends NavigationApplication {

  private final ReactNativeHost mReactNativeHost =
      new NavigationReactNativeHost(this) {
        @Override
        public boolean getUseDeveloperSupport() {
          return BuildConfig.DEBUG;
        }

        @Override
        protected List<ReactPackage> getPackages() {
          @SuppressWarnings("UnnecessaryLocalVariable")
          List<ReactPackage> packages = new PackageList(this).getPackages();
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // packages.add(new MyReactNativePackage());
          packages.add(new CachePackage());
          packages.add(new SoundEffectPackage());
          // 蓝牙输出状态（只读）+ 开发者选项入口：不参与音频处理
          packages.add(new BtAudioPackage());
          // 极客功能：CUE 分轨的无损切片导出（纯解码，双端都可用）
          packages.add(new CueExportPackage());
          // 变体隔离：管理端（com.yieyu.music.admin）绝不注册客户端专属模块，
          // 否则两个包共存时悬浮窗/传歌服务可能由管理端实例起来，点击就会跳到发卡机
          if (!BuildConfig.APPLICATION_ID.endsWith(".admin")) {
            packages.add(new LanSharePackage());
          }
          packages.add(new DownloadPackage());
          packages.add(new RecognizePackage());
          packages.add(new LyricPackage());
          packages.add(new UtilsPackage());
          // M0：Fat Core 门面（业务状态/网络/存储将逐步下沉到 C++）
          packages.add(new CorePackage());
          packages.add(new CryptoPackage());
          packages.add(new UserApiPackage());
          return packages;
        }

        @Override
        protected String getJSMainModuleName() {
          return "index";
        }

        @Override
        protected boolean isNewArchEnabled() {
          return BuildConfig.IS_NEW_ARCHITECTURE_ENABLED;
        }

        @Override
        protected Boolean isHermesEnabled() {
          return BuildConfig.IS_HERMES_ENABLED;
        }
      };

  @Override
  public ReactNativeHost getReactNativeHost() {
    return mReactNativeHost;
  }

  @Override
  public void onCreate() {
    super.onCreate();

    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      DefaultNewArchitectureEntryPoint.load();
    }
    ReactNativeFlipper.initializeFlipper(this, getReactNativeHost().getReactInstanceManager());
  }
}
