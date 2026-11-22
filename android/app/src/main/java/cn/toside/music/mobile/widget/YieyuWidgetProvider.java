package cn.toside.music.mobile.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

/** 桌面灵动胶囊：接收点击广播并转成 JS 事件，播放控制最终由 JS 调 TrackPlayer 执行，语义与 App 内一致 */
public final class YieyuWidgetProvider extends AppWidgetProvider {
    public static final String ACTION_PLAY_PAUSE = "cn.toside.music.mobile.widget.PLAY_PAUSE";
    public static final String ACTION_PREV = "cn.toside.music.mobile.widget.PREV";
    public static final String ACTION_NEXT = "cn.toside.music.mobile.widget.NEXT";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) {
            RemoteViews views = WidgetRender.build(context, "Yieyu 音乐", "点一下开始播放", false, null, 0);
            manager.updateAppWidget(id, views);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (ACTION_PLAY_PAUSE.equals(action)) {
            WidgetModule.dispatch("play_pause");
        } else if (ACTION_PREV.equals(action)) {
            WidgetModule.dispatch("prev");
        } else if (ACTION_NEXT.equals(action)) {
            WidgetModule.dispatch("next");
        }
    }
}
