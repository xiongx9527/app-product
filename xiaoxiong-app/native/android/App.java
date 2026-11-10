// 应用入口：App 主进程（UI 进程）启动时拉起网关 Service（:gateway 独立进程）。
//
// 关键约束（对应 docs/mobile-embedded-gateway.md §3 / §15）：
//  - 离线 SDK 要求 Application 必须继承 io.dcloud.application.DCloudApplication，
//    否则 uni-app 运行时初始化缺失；故此处 extends 它并在 onCreate 先 super() 再拉网关。
//  - 网关 Service 声明在 android:process=":gateway"，自身就在那个进程跑；
//  - 必须在「主/UI 进程」才 startService，否则 :gateway 进程会再拉一个自己，导致
//    node 被重复初始化（V8 assert 直接崩）。用 processName 与包名比较来守卫。
package com.xiaoxiong.assistant;

import android.content.Intent;
import android.util.Log;

import com.xiaoxiong.assistant.gateway.GatewayNodeService;
import io.dcloud.application.DCloudApplication;

public class App extends DCloudApplication {
    private static final String TAG = "XiaoxiongApp";

    @Override
    public void onCreate() {
        super.onCreate();
        // 仅主进程拉起网关；:gateway 进程跳过，避免自我重复初始化。
        if (isMainProcess()) {
            try {
                startService(new Intent(this, GatewayNodeService.class));
                Log.i(TAG, "gateway service start requested (main process)");
            } catch (Throwable e) {
                // 启动失败不应拖垮 App 启动：网关缺失时客户端走 H5/外部网关兜底。
                Log.e(TAG, "start gateway service failed", e);
            }
        }
    }

    /** 当前进程是否为主/UI 进程：processName == 包名即主进程，":gateway" 等后缀为非主进程。 */
    private boolean isMainProcess() {
        final String processName = getApplicationInfo().processName;
        return getPackageName().equals(processName);
    }
}
