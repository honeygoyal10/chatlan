package com.hamariduniya.lanchat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundConnectionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
