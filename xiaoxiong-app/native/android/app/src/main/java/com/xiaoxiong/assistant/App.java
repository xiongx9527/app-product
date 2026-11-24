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

import androidx.core.content.ContextCompat;

import com.xiaoxiong.assistant.gateway.GatewayControlModule;
import com.xiaoxiong.assistant.gateway.GatewayNodeService;
import com.xiaoxiong.assistant.wake.WakeModule;
import io.dcloud.application.DCloudApplication;
import io.dcloud.feature.uniapp.UniSDKEngine;

public class App extends DCloudApplication {
    private static final String TAG = "XiaoxiongApp";

    @Override
    public void onCreate() {
        super.onCreate();
        // 仅主进程拉起网关；:gateway 进程跳过，避免自我重复初始化。
        if (isMainProcess()) {
            registerNativeModules();
            try {
                // 用 startForegroundService 拉起（API 26+ 前台服务的正确入口）；
                // GatewayNodeService.onCreate 会立即 startForeground，二者配套避免 ANR。
                ContextCompat.startForegroundService(this, new Intent(this, GatewayNodeService.class));
                Log.i(TAG, "gateway foreground service start requested (main process)");
            } catch (Throwable e) {
                // 启动失败不应拖垮 App 启动：网关缺失时客户端走 H5/外部网关兜底。
                Log.e(TAG, "start gateway service failed", e);
            }
        }
    }

    /**
     * 代码注册自定义原生插件。
     *
     * 为什么必须代码注册：uni.requireNativePlugin(id) 在引擎里等价于 weex 的 requireModule(id)，
     * 查的是 WXSDKEngine.registerModule 建立的模块注册表；dcloud_properties.xml 里的 <feature>
     * 是老式 plus.bridge.exec 插件机制，对继承 UniModule / @UniJSMethod 的插件无效。
     * 只在 xml 里声明而不在这里 registerUniModule，requireNativePlugin('app-product-wake')
     * 会永远返回 undefined → 前端 PCM 采集链路整条断掉 → 喊「小熊小熊」无反应。
     *
     * 必须在 super.onCreate() 之后（DCloud 引擎已初始化）调用，第三参 false = 非单例。
     */
    private void registerNativeModules() {
        try {
            boolean ok = UniSDKEngine.registerUniModule("app-product-wake", WakeModule.class, false);
            Log.i(TAG, "registerUniModule(app-product-wake) => " + ok);
            // 网关控制插件：JS 点中间圆球/设置页重启卡死的网关进程
            boolean gwOk = UniSDKEngine.registerUniModule("app-product-gateway", GatewayControlModule.class, false);
            Log.i(TAG, "registerUniModule(app-product-gateway) => " + gwOk);
        } catch (Throwable e) {
            Log.e(TAG, "registerUniModule(app-product-wake) failed", e);
        }
    }

  /** 当前进程是否为主/UI 进程：进程名 == 包名即主进程，":gateway" 等后缀为非主进程。
   *  必须读 /proc/self/cmdline，不能用 getApplicationInfo().processName——后者在部分
   *  Android/SDK 版本下于 :gateway 进程里仍返回裸包名（不含 ":gateway" 后缀），导致
   *  isMainProcess() 误判为 true，:gateway 进程也去 startForegroundService/registerUniModule，
   *  重复初始化造成竞态，偶发表现为「关掉重开后网关起不来」。实测 /proc/self/cmdline
   *  在 :gateway 进程为 "com.xiaoxiong.assistant:gateway"，可可靠区分。 */
  private boolean isMainProcess() {
    final String pkg = getPackageName();
    String cmdline = "";
    try (java.io.BufferedReader r = new java.io.BufferedReader(
        new java.io.FileReader("/proc/self/cmdline"))) {
      cmdline = r.readLine();
    } catch (Throwable ignored) { }
    if (cmdline != null) {
      // cmdline 以 \0 结尾/分隔，readLine 可能只取到第一段；取首个 \0 之前的部分
      int nul = cmdline.indexOf('\0');
      String procName = nul >= 0 ? cmdline.substring(0, nul) : cmdline.trim();
      if (!procName.isEmpty()) return pkg.equals(procName);
    }
    // 读不到 /proc 时的兜底：退回进程名比较（多数机型正确）
    return pkg.equals(getApplicationInfo().processName);
  }
}
