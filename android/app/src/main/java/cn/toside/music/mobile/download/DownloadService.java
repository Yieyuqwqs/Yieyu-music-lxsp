package cn.toside.music.mobile.download;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;

import cn.toside.music.mobile.R;

/**
 * 下载保活前台服务：保证 App 切后台/锁屏时下载不被系统回收
 */
public class DownloadService extends Service {
  private static final String CHANNEL_ID = "lx_music_download";
  private static final int NOTIFICATION_ID = 20123;

  public static void start(Context context) {
    try {
      Intent intent = new Intent(context, DownloadService.class);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent);
      } else {
        context.startService(intent);
      }
    } catch (Throwable ignored) {
    }
  }

  public static void stop(Context context) {
    try {
      context.stopService(new Intent(context, DownloadService.class));
    } catch (Throwable ignored) {
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    startForeground(NOTIFICATION_ID, buildNotification());
    return START_NOT_STICKY;
  }

  private Notification buildNotification() {
    Notification.Builder builder;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
      if (manager != null) {
        NotificationChannel channel = new NotificationChannel(
          CHANNEL_ID,
          getString(R.string.download_service_channel_name),
          NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.download_service_channel_desc));
        manager.createNotificationChannel(channel);
      }
      builder = new Notification.Builder(this, CHANNEL_ID);
    } else {
      builder = new Notification.Builder(this);
    }
    builder.setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(getString(R.string.download_service_title))
      .setContentText(getString(R.string.download_service_text))
      .setOngoing(true);
    return builder.build();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onDestroy() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE);
      } else {
        stopForeground(true);
      }
    } catch (Throwable ignored) {
    }
    super.onDestroy();
  }
}
