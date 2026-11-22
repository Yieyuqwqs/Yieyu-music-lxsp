package cn.toside.music.mobile.widget;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.widget.RemoteViews;

import cn.toside.music.mobile.MainActivity;
import cn.toside.music.mobile.R;

/** 桌面胶囊的渲染：纯 Java 画频谱 bitmap + RemoteViews 装配，不依赖 RN 桥 */
final class WidgetRender {
    private static final int DEFAULT_ACCENT = 0xFF4DAF7C;

    private WidgetRender() {
    }

    static RemoteViews build(Context context, String title, String artist, boolean playing, int[] bands, int accent) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.yieyu_widget);
        String safeTitle = title == null || title.isEmpty() ? "Yieyu 音乐" : title;
        String safeArtist = artist == null ? "" : artist;
        views.setTextViewText(R.id.yieyu_widget_title, safeTitle);
        views.setTextViewText(R.id.yieyu_widget_artist, safeArtist);
        views.setTextViewText(R.id.yieyu_widget_play, playing ? "||" : "\u25B6");
        views.setImageViewBitmap(R.id.yieyu_widget_spectrum, renderBands(320, 40, bands, accent));
        views.setOnClickPendingIntent(R.id.yieyu_widget_prev, broadcast(context, YieyuWidgetProvider.ACTION_PREV, 21));
        views.setOnClickPendingIntent(R.id.yieyu_widget_play, broadcast(context, YieyuWidgetProvider.ACTION_PLAY_PAUSE, 22));
        views.setOnClickPendingIntent(R.id.yieyu_widget_next, broadcast(context, YieyuWidgetProvider.ACTION_NEXT, 23));
        views.setOnClickPendingIntent(R.id.yieyu_widget_root, openApp(context));
        return views;
    }

    private static PendingIntent broadcast(Context context, String action, int code) {
        Intent intent = new Intent(context, YieyuWidgetProvider.class);
        intent.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (android.os.Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, code, intent, flags);
    }

    private static PendingIntent openApp(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (android.os.Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, 24, intent, flags);
    }

    private static Bitmap renderBands(int width, int height, int[] bands, int accent) {
        int color = accent == 0 ? DEFAULT_ACCENT : accent;
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(color & 0x00FFFFFF | 0xD0000000);
        int count = bands != null && bands.length > 1 ? bands.length : 0;
        if (count == 0) {
            // 没数据时画一条低幅静止波形，避免组件一片空白
            count = 24;
            bands = new int[count];
            for (int i = 0; i < count; i++) {
                bands[i] = (int) (28 + 16 * Math.abs(Math.sin(i * 0.7)));
            }
        }
        float gap = 3f;
        float barWidth = (width - gap * (count - 1)) / count;
        if (barWidth < 1f) barWidth = 1f;
        RectF rect = new RectF();
        for (int i = 0; i < count; i++) {
            float value = Math.max(0f, Math.min(1f, bands[i] / 255f));
            float barHeight = Math.max(4f, value * height);
            float left = i * (barWidth + gap);
            rect.set(left, height - barHeight, left + barWidth, height);
            float radius = Math.min(barWidth / 2f, 3f);
            canvas.drawRoundRect(rect, radius, radius, paint);
        }
        return bitmap;
    }
}
