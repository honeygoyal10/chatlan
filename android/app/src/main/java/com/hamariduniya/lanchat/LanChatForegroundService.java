package com.hamariduniya.lanchat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * Keeps the app process (and its WebView / socket.io connection) alive in the
 * background — same trick WhatsApp/Telegram use: a low-priority persistent
 * notification tied to a foreground Service. Started on login, stopped on
 * logout, so the LAN chat only "runs in the backend" while logged in.
 */
public class LanChatForegroundService extends Service {

    public static final String CHANNEL_ID = "lanchat_running";
    public static final int NOTIFICATION_ID = 4201;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannelIfNeeded();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = "LAN Chat connected — background me active hai";
        if (intent != null && intent.hasExtra("text")) {
            String t = intent.getStringExtra("text");
            if (t != null && !t.isEmpty()) text = t;
        }
        startForeground(NOTIFICATION_ID, buildNotification(text));
        return START_STICKY;
    }

    private Notification buildNotification(String text) {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("LAN Chat")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(pendingIntent)
                .build();
    }

    private void createChannelIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "LAN Chat background connection", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Login rehte huye LAN Chat ko background me connected rakhta hai");
            manager.createNotificationChannel(channel);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
