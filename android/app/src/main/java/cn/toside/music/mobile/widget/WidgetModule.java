package cn.toside.music.mobile.widget;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.widget.RemoteViews;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.lang.ref.WeakReference;

/** JS → 桌面组件的单向推送口：JS 侧 4~8 fps 推歌曲信息 + 频谱，Java 只负责渲染 */
public final class WidgetModule extends ReactContextBaseJavaModule {
    private static WeakReference<ReactApplicationContext> shared = new WeakReference<>(null);

    public WidgetModule(ReactApplicationContext context) {
        super(context);
        shared = new WeakReference<>(context);
    }

    @Override
    public String getName() {
        return "YieyuWidgetModule";
    }

    /** 组件按钮 → JS（App 进程在时才有反应；进程被系统回收时按钮静默失效，不崩） */
    static void dispatch(String command) {
        ReactApplicationContext context = shared.get();
        if (context == null) return;
        try {
            WritableMap map = Arguments.createMap();
            map.putString("command", command);
            context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("YieyuWidgetAction", map);
        } catch (Throwable ignored) {
        }
    }

    @ReactMethod
    public void update(ReadableMap state, Promise promise) {
        try {
            Context context = getReactApplicationContext();
            String title = state.hasKey("title") && !state.isNull("title") ? state.getString("title") : "";
            String artist = state.hasKey("artist") && !state.isNull("artist") ? state.getString("artist") : "";
            boolean playing = state.hasKey("playing") && state.getBoolean("playing");
            int accent = state.hasKey("accent") ? state.getInt("accent") : 0;
            int[] bands = new int[0];
            if (state.hasKey("bands") && !state.isNull("bands")) {
                ReadableArray array = state.getArray("bands");
                if (array != null && array.size() > 0) {
                    bands = new int[array.size()];
                    for (int i = 0; i < bands.length; i++) bands[i] = (int) Math.round(array.getDouble(i));
                }
            }
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            ComponentName name = new ComponentName(context, YieyuWidgetProvider.class);
            int[] ids = manager.getAppWidgetIds(name);
            if (ids != null && ids.length > 0) {
                RemoteViews views = WidgetRender.build(context, title, artist, playing, bands, accent);
                for (int id : ids) manager.updateAppWidget(id, views);
            }
            promise.resolve(ids == null ? 0 : ids.length);
        } catch (Throwable error) {
            promise.reject("widget_update_failed", error);
        }
    }

    @ReactMethod
    public void getWidgetCount(Promise promise) {
        try {
            Context context = getReactApplicationContext();
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            int[] ids = manager.getAppWidgetIds(new ComponentName(context, YieyuWidgetProvider.class));
            promise.resolve(ids == null ? 0 : ids.length);
        } catch (Throwable error) {
            promise.reject("widget_count_failed", error);
        }
    }
}
