package com.hamariduniya.lanchat;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * JS side calls:
 *   Capacitor.Plugins.BackgroundConnection.start({ text: '...' })  -> on login
 *   Capacitor.Plugins.BackgroundConnection.stop()                  -> on logout
 * This starts/stops the persistent foreground-service notification that keeps
 * the socket.io connection (running inside the WebView JS) alive while the
 * app is minimized — same as WhatsApp staying "online" in background.
 */
@CapacitorPlugin(name = "BackgroundConnection")
public class BackgroundConnectionPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String text = call.getString("text", "LAN Chat connected — background me active hai");
        Intent intent = new Intent(getContext(), LanChatForegroundService.class);
        intent.putExtra("text", text);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), LanChatForegroundService.class);
        getContext().stopService(intent);
        call.resolve();
    }
}
