// Android 网关原生服务：在独立进程（:gateway）里加载 digidem 的 libnode.so 并启动网关 bundle。
//
// 设计要点（对应 docs/mobile-embedded-gateway.md §12/#1、EMBEDDING.md）：
//  - 独立进程：AndroidManifest 中声明 android:process=":gateway"，与 DCloud 前台 UI 进程隔离；
//  - 资产解包：首次启动把 assets/gateway/ 下的 gateway.bundle.mjs + cues 拷到 getNoBackupFilesDir()
//    （持久、不进自动备份，避免设备绑定状态被恢复到别的设备）；
//  - 端口回传：JNI 桥启动 node 后，bundle（src/embedded/entry.ts）把实际端口写进
//    <home>/.gateway_port，Service 轮询该文件并广播给 UI 进程（LocalBroadcast / 持久化供客户端读取）；
//  - node 必须在后台线程跑：JNI 桥内部 detach 一个 std::thread 调 node::Start，本 Service 主线程立即返回，
//    否则 Android 会把 Service 判为 ANR 杀掉。
package com.xiaoxiong.assistant.gateway;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public class GatewayNodeService extends Service {
    private static final String TAG = "GatewayNode";
    private static final String BUNDLE_NAME = "gateway.bundle.mjs";
    private static final String PORT_FILE = ".gateway_port";

    static {
        // libnode.so（digidem v24.20.0）已在 jniLibs/<abi>/；先显式加载，保证 libgatewaynode.so
        // 的 DT_NEEDED 依赖能被解析（部分 Android 版本不会自动解析二级依赖）。
        System.loadLibrary("node");
        System.loadLibrary("gatewaynode");
    }

    // 在后台线程调 node::Start；参数 = node 的 argv（argv[0] 占位，argv[1] 为 bundle 路径）。
    // homeDir / cacheDir 用于设置 GATEWAY_HOME / TMPDIR 等（Android 无 /tmp）。
    private native void nativeStartNode(String homeDir, String cacheDir, String[] nodeArgs);

    @Override
    public void onCreate() {
        super.onCreate();
        File home = getNoBackupFilesDir(); // /data/user/0/<pkg>/no_backup
        File cache = getCacheDir();         // /data/user/0/<pkg>/cache
        try {
            extractAssets(home);
        } catch (IOException e) {
            Log.e(TAG, "extract gateway assets failed", e);
            return;
        }
        final File bundle = new File(home, BUNDLE_NAME);
        new Thread(() -> {
            String[] args = new String[] { "node", bundle.getAbsolutePath() };
            nativeStartNode(home.getAbsolutePath(), cache.getAbsolutePath(), args);
        }, "gateway-node").start();

        pollPort(home);
    }

    // 把 assets/gateway/ 整体拷到 home（首启或版本变更时）。
    // assets 下是嵌套目录（cues 在 gateway/static/cues/），必须递归，否则提示音拷不过去。
    private void extractAssets(File home) throws IOException {
        copyAssetDir("gateway", home);
        Log.i(TAG, "gateway assets extracted to " + home.getAbsolutePath());
    }

    // AssetManager.list 对「目录」返回子项名、对「文件」返回空数组、对不存在路径返回 null。
    private void copyAssetDir(String assetPath, File dest) throws IOException {
        String[] entries = getAssets().list(assetPath);
        if (entries == null) return;
        if (entries.length > 0) {
            dest.mkdirs(); // 目录：递归
            for (String name : entries) {
                copyAssetDir(assetPath + "/" + name, new File(dest, name));
            }
        } else {
            dest.getParentFile().mkdirs(); // 文件：直接拷
            try (InputStream in = getAssets().open(assetPath);
                 FileOutputStream fos = new FileOutputStream(dest)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
            }
        }
    }

    // 轮询端口文件，出现后通知客户端（此处用广播 + 持久化文件双通道，UI 进程读取后注入 ws URL）。
    // 用 java.io 而非 java.nio.file：后者在 Android API 26+ 才有，而本工程 minSdk 21。
    private void pollPort(File home) {
        final File portFile = new File(home, PORT_FILE);
        new Thread(() -> {
            for (int i = 0; i < 300; i++) { // 最多 ~60s
                if (portFile.exists()) {
                    String port = readFirstLine(portFile);
                    if (port != null && !port.isEmpty()) {
                        Log.i(TAG, "gateway ready on port " + port);
                        // TODO: LocalBroadcastManager.sendBroadcast(new Intent(ACTION_GATEWAY_READY).putExtra("port", port));
                        // TODO: 客户端 core/transport 读取本端口拼 ws://127.0.0.1:<port>
                        return;
                    }
                }
                try { Thread.sleep(200); } catch (InterruptedException e) { return; }
            }
            Log.e(TAG, "gateway port file not found within timeout");
        }, "gateway-port-poll").start();
    }

    private String readFirstLine(File f) {
        try (BufferedReader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(f), StandardCharsets.UTF_8))) {
            String line = r.readLine();
            return line == null ? null : line.trim();
        } catch (IOException e) {
            return null;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY; // 被杀后系统兜底重启（保活，配合前台服务更稳）
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
