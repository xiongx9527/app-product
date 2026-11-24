// app-product-gateway 原生插件（Android）：JS 侧主动重启卡死的网关进程。
//
// 背景：网关跑在 :gateway 独立进程的前台 Service（GatewayNodeService），node::Start 在 detach
// 线程里跑、没有可干净停止的句柄。当网关进程活着、WS 也连着，但 8787 事件循环卡死时，
// 前端只能靠用户点中间圆球触发本模块重启网关——stopService 触发 Service.onDestroy，
// onDestroy 里 killProcess 整个 :gateway 进程（连同 detach 的 node 线程一起清掉），
// 主进程延迟后再 startForegroundService 重新拉起干净网关。
//
// 注册：App.java registerNativeModules() 里 registerUniModule("app-product-gateway", ...)。
// 运行在主进程（JS 调用方所在进程），不碰 :gateway 进程内部状态，只做「停 + 起」编排。
package com.xiaoxiong.assistant.gateway;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import io.dcloud.feature.uniapp.annotation.UniJSMethod;
import io.dcloud.feature.uniapp.bridge.UniJSCallback;
import io.dcloud.feature.uniapp.common.UniModule;

import org.json.JSONObject;

public class GatewayControlModule extends UniModule {
    private static final String TAG = "GatewayControl";

    /**
     * JS 调 instance.restartGateway(cb) 重启网关进程。
     * cb 回 {ok:true} 表示「已发起重启」；前端以 health 轮询为 ready 权威，不靠本回调判定恢复。
     */
    @UniJSMethod(uiThread = true)
    public void restartGateway(UniJSCallback cb) {
        Log.i(TAG, "restartGateway requested");
        final Context activityCtx = mWXSDKInstance != null ? mWXSDKInstance.getContext() : null;
        if (activityCtx == null) {
            Log.e(TAG, "restartGateway: no context");
            callback(cb, false);
            return;
        }
        // 用 applicationContext：延迟 1200ms 后 startForegroundService，届时 Activity 可能已销毁，
        // 持有 Activity context 会泄漏甚至抛异常；application context 全程有效。
        final Context ctx = activityCtx.getApplicationContext();
        try {
            Intent intent = new Intent(ctx, GatewayNodeService.class);
            // stopService → GatewayNodeService.onDestroy → killProcess(:gateway 进程)
            ctx.stopService(intent);
            Log.i(TAG, "stopService posted, :gateway will be killed in onDestroy");
        } catch (Throwable e) {
            Log.w(TAG, "stopService failed", e);
        }
        // 延迟再拉起：给 onDestroy 的 killProcess 留时间，避免新旧 node 实例端口冲突/V8 assert。
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try {
                androidx.core.content.ContextCompat.startForegroundService(ctx, new Intent(ctx, GatewayNodeService.class));
                Log.i(TAG, "gateway foreground service restart requested");
                callback(cb, true);
            } catch (Throwable e) {
                Log.e(TAG, "restart service failed", e);
                callback(cb, false);
            }
        }, 1200);
    }

    private static void callback(UniJSCallback cb, boolean ok) {
        if (cb == null) return;
        try {
            JSONObject payload = new JSONObject();
            payload.put("ok", ok);
            cb.invokeAndKeepAlive(payload);
        } catch (Throwable ignored) { }
    }
}
