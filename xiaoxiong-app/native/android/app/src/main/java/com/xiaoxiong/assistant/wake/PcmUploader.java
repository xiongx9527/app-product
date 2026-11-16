// 原生 PCM 直连网关上报。
//
// 为什么需要它：真机诊断（session.diag 通道）确认——播报期 TTS 下行音频帧大量冲击 JS 线程时，
// DCloud weex 的 pcmFrameCb.invokeAndKeepAlive 回调会被丢弃，JS onPcm 每 2 秒收帧从 63 骤降到 1，
// 而原生采集正常（每秒 31 帧）。帧在上游就没到 JS，导致网关播报期收不到真人插话、ASR 识别成乱码。
// 绕开方案：原生把采集到的 PCM 直接用 OkHttp WebSocket 发给网关「音频专用连接」（?role=pcm），
// 不经过 weex 回调。该连接只喂 session.handleBinary、不 bindTransport，不影响 JS 主连接的事件收发。
//
// 容错：任何失败（端口文件没就绪/网关未启动/连接断开）都静默、自动重连，绝不影响采集主循环；
// 原有的 pcmFrameCb → JS 路径保留（非播报期正常、作为降级双保险），只有播报期才依赖直连。

package com.xiaoxiong.assistant.wake;

import android.content.Context;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

public final class PcmUploader {
    private static final String TAG = "PcmUploader";
    private static final String PORT_FILE = ".gateway_port";
    private static volatile PcmUploader instance;

    private final Context context;
    private final OkHttpClient client;
    private WebSocket ws;
    private String deviceId;
    private volatile boolean enabled = false;
    private volatile long lastConnectAttempt = 0;

    private PcmUploader(Context context) {
        this.context = context.getApplicationContext();
        this.client = new OkHttpClient.Builder()
                .connectTimeout(2, TimeUnit.SECONDS)
                .pingInterval(10, TimeUnit.SECONDS)
                .build();
    }

    public static PcmUploader get(Context context) {
        if (instance == null) {
            synchronized (PcmUploader.class) {
                if (instance == null) instance = new PcmUploader(context);
            }
        }
        return instance;
    }

    /** JS 调 startPcm 前配置 deviceId，并开启原生直连。 */
    public void configure(String deviceId) {
        this.deviceId = deviceId;
        this.enabled = true;
        Log.i(TAG, "configure deviceId=" + deviceId);
        connect();
    }

    public void stop() {
        enabled = false;
        if (ws != null) {
            try { ws.close(1000, "stop"); } catch (Throwable ignored) {}
            ws = null;
        }
    }

    /** 采集循环每帧调用；连接未就绪时静默丢弃（非播报期仍走 weex 回调，不依赖这里）。 */
    public void upload(byte[] pcm) {
        if (!enabled || pcm == null || pcm.length == 0) return;
        WebSocket cur = ws;
        if (cur == null) {
            // 限频重连，避免采集线程每帧都尝试
            long now = System.currentTimeMillis();
            if (now - lastConnectAttempt > 1000) {
                lastConnectAttempt = now;
                connect();
            }
            return;
        }
        try {
            cur.send(ByteString.of(pcm, 0, pcm.length));
        } catch (Throwable e) {
            Log.w(TAG, "upload send failed: " + e.getMessage());
            ws = null;
        }
    }

    private String readPort() {
        try {
            File f = new File(context.getNoBackupFilesDir(), PORT_FILE);
            if (!f.exists()) return null;
            BufferedReader r = new BufferedReader(new FileReader(f));
            String line = r.readLine();
            r.close();
            return (line != null && !line.trim().isEmpty()) ? line.trim() : null;
        } catch (Throwable e) {
            return null;
        }
    }

    private synchronized void connect() {
        if (!enabled || ws != null) return;
        String port = readPort();
        if (port == null || deviceId == null) return;
        String url = "ws://127.0.0.1:" + port + "/ws?deviceId=" + deviceId + "&role=pcm";
        try {
            Request req = new Request.Builder().url(url).build();
            ws = client.newWebSocket(req, new WebSocketListener() {
                @Override
                public void onOpen(WebSocket webSocket, Response response) {
                    Log.i(TAG, "connected: " + url);
                }
                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    if (ws == webSocket) ws = null;
                    Log.w(TAG, "closed: " + code + " " + reason);
                }
                @Override
                public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                    if (ws == webSocket) ws = null;
                    Log.w(TAG, "failure: " + (t == null ? "" : t.getMessage()));
                }
            });
            Log.i(TAG, "connecting: " + url);
        } catch (Throwable e) {
            Log.w(TAG, "connect failed: " + e.getMessage());
        }
    }
}
