// app-product-wake 原生插件（Android/DCloud 离线 SDK）。
//
// 为什么需要它：
//   uni-app 的 uni.getRecorderManager 在 App 端不支持 onFrameRecorded，拿不到实时 PCM 分片，
//   无法满足网关「16k/16bit/单声道 PCM 分片上行」契约。App 端的麦克风输入完全由本插件提供。
//
// 职责（与 JS 侧 appCapture.ts / providers/native.ts 的接口一一对应）：
//   PCM 采集（对话/唤醒的音频来源）：startPcm / stopPcm / onPcmFrame / onPcmError
//   声学唤醒占位（KWS 模型未集成前不触发 onWake；唤醒判定当前由网关 ASR + JS matchWakeWord 完成）：
//     start / stop / onWake / onError
//
// 注册：在 simpleDemo/src/main/assets/data/dcloud_properties.xml 里加
//   <feature name="app-product-wake" value="com.xiaoxiong.assistant.wake.WakeModule"/>
// JS 经 uni.requireNativePlugin('app-product-wake') 加载。
//
// 权限：AndroidManifest 声明 RECORD_AUDIO，且运行时权限由 JS 侧（uni.authorize scope.record）
//   在调用 startPcm 之前请求——uni-app 框架不会为原生 AudioRecord 代为请求，WXModule 也不保证
//   把 onRequestPermissionsResult 转发到本插件，故插件只做「检查 + 无权限回报」，不主动请求。

package com.xiaoxiong.assistant.wake;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import io.dcloud.feature.uniapp.annotation.UniJSMethod;
import io.dcloud.feature.uniapp.bridge.UniJSCallback;
import io.dcloud.feature.uniapp.common.UniModule;

public class WakeModule extends UniModule {
    private static final String TAG = "WakeModule";
    /** 上行契约：16k / 16bit / 单声道 / 32ms 分片，与 contracts/README.md 一致。 */
    private static final int SAMPLE_RATE = 16000;
    private static final int CHANNELS = 1;
    private static final int BITS = 16;
    private static final int FRAME_MS = 32;
    /** 每多少帧打一次统计日志，避免刷屏。 */
    private static final int LOG_EVERY_FRAMES = 50;

    public WakeModule() {
        Log.i(TAG, "WakeModule instantiated");
    }

    private AudioRecord recorder;
    private Thread captureThread;
    private volatile boolean running = false;

    // JS 侧注册的回调；keepAlive 模式可多次调用。
    private UniJSCallback pcmFrameCb;
    private UniJSCallback pcmErrorCb;
    private UniJSCallback wakeCb;
    private UniJSCallback wakeErrCb;

    // ---- PCM 采集接口（core/audio/appCapture.ts 使用）----

    @UniJSMethod(uiThread = false)
    public void onPcmFrame(UniJSCallback cb) {
        if (cb != null) {
            pcmFrameCb = cb;
            Log.i(TAG, "onPcmFrame registered");
        }
    }

    @UniJSMethod(uiThread = false)
    public void onPcmError(UniJSCallback cb) {
        if (cb != null) pcmErrorCb = cb;
    }

    /** JS 调用 instance.startPcm({ sampleRate, channels, bitsPerSample, frameMs })（无回调）。 */
    @UniJSMethod(uiThread = false)
    public void startPcm(JSONObject options) {
        Log.i(TAG, "startPcm called");
        startCapture();
    }

    @UniJSMethod(uiThread = false)
    public void stopPcm() {
        Log.i(TAG, "stopPcm called");
        stopCapture();
    }

    // ---- 声学唤醒接口（providers/native.ts 使用；KWS 未集成前 onWake 不触发）----

    @UniJSMethod(uiThread = false)
    public void start(JSONObject options, UniJSCallback cb) {
        // 当前唤醒判定在网关 ASR + JS，本插件只负责把音频采上来。
        Log.i(TAG, "start called (wake placeholder)");
        startCapture();
    }

    @UniJSMethod(uiThread = false)
    public void stop() {
        stopCapture();
    }

    @UniJSMethod(uiThread = false)
    public void onWake(UniJSCallback cb) {
        if (cb != null) wakeCb = cb;
    }

    @UniJSMethod(uiThread = false)
    public void onError(UniJSCallback cb) {
        if (cb != null) wakeErrCb = cb;
    }

    // ---- 采集实现 ----

    private Context safeContext() {
        return (mWXSDKInstance != null) ? mWXSDKInstance.getContext() : null;
    }

    private void startCapture() {
        if (running) {
            Log.i(TAG, "startCapture ignored: already running");
            return;
        }
        if (!ensurePermission()) {
            // 权限由 JS 侧在调用前请求；此处仅检查并回报。未授权说明前端请求被拒。
            return;
        }
        try {
            int minBuf = AudioRecord.getMinBufferSize(
                    SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            // 每帧字节数 = 采样率 * 声道 * (位深/8) * 帧时长(ms) / 1000 = 16000*1*2*32/1000 = 1024
            int frameBytes = SAMPLE_RATE * CHANNELS * (BITS / 8) * FRAME_MS / 1000;
            int bufSize = Math.max(minBuf, frameBytes * 4);
            recorder = new AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufSize);
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord init failed (device unsupported config)");
                emitError("AudioRecord 初始化失败（设备不支持该录音配置）");
                recorder.release();
                recorder = null;
                return;
            }
            recorder.startRecording();
            running = true;
            captureThread = new Thread(this::captureLoop, "wake-pcm-capture");
            captureThread.start();
            Log.i(TAG, "AudioRecord started: " + SAMPLE_RATE + "Hz/" + CHANNELS + "ch/" + BITS + "bit, frame=" + frameBytes + "B");
        } catch (Throwable e) {
            Log.e(TAG, "startCapture failed: " + e.getMessage(), e);
            emitError("启动录音失败: " + e.getMessage());
        }
    }

    private void captureLoop() {
        int frameBytes = SAMPLE_RATE * CHANNELS * (BITS / 8) * FRAME_MS / 1000;
        final byte[] frame = new byte[frameBytes];
        int count = 0;
        while (running && recorder != null && recorder.getState() == AudioRecord.STATE_INITIALIZED) {
            int read;
            try {
                read = recorder.read(frame, 0, frameBytes);
            } catch (Throwable e) {
                Log.e(TAG, "read failed: " + e.getMessage());
                emitError("读取音频失败: " + e.getMessage());
                break;
            }
            if (read != frameBytes) continue; // 不足一帧（罕见），丢弃以保证分片时长恒定
            count++;
            if (count % LOG_EVERY_FRAMES == 0) {
                Log.d(TAG, "pcm frames=" + count + " (" + (count * FRAME_MS) + "ms)");
            }
            if (pcmFrameCb != null) {
                try {
                    // byte[] 经 DCloud 桥转成前端 ArrayBuffer，appCapture.toArrayBuffer 兼容处理
                    pcmFrameCb.invokeAndKeepAlive(frame.clone());
                } catch (Throwable ignored) {
                    // 回调失败（如 JS 已解绑）忽略，继续采集
                }
            }
        }
        Log.i(TAG, "captureLoop ended, total frames=" + count);
    }

    private void stopCapture() {
        running = false;
        if (recorder != null) {
            try {
                recorder.stop();
                recorder.release();
            } catch (Throwable ignored) {
            }
            recorder = null;
        }
        if (captureThread != null) {
            try {
                captureThread.join(500);
            } catch (Throwable ignored) {
            }
            captureThread = null;
        }
    }

    /** 检查麦克风权限；已授权返回 true，否则回报缺失并返 false（请求由 JS 侧负责）。 */
    private boolean ensurePermission() {
        Context ctx = safeContext();
        if (ctx == null) {
            Log.e(TAG, "ensurePermission: no context");
            emitError("无法获取上下文，无法检查麦克风权限");
            return false;
        }
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "permission: granted");
            return true;
        }
        Log.w(TAG, "permission: DENIED -> report NEED_PERMISSION");
        emitError("NEED_PERMISSION");
        return false;
    }

    private void emitError(String msg) {
        if (pcmErrorCb != null) {
            try {
                pcmErrorCb.invokeAndKeepAlive(msg);
            } catch (Throwable ignored) {
            }
        }
    }
}
