// app-product-wake 原生插件（Android/DCloud 离线 SDK）。
//
// 为什么需要它：
//   uni-app 的 uni.getRecorderManager 在 App 端不支持 onFrameRecorded，拿不到实时 PCM 分片，
//   无法满足网关「16k/16bit/单声道 PCM 分片上行」契约。App 端的麦克风输入完全由本插件提供。
//
// 职责（与 JS 侧 appCapture.ts / appPlayback.ts / providers/native.ts 的接口一一对应）：
//   PCM 采集（对话/唤醒的音频来源）：startPcm / stopPcm / onPcmFrame / onPcmError
//   TTS 播放（App 逻辑层无 WebAudio，网关下发的 24k PCM 只能由原生 AudioTrack 播）：
//     startPlayback / playPcm({data:[...]}) / stopPlayback / onPlaybackIdle
//   playPcm 必须收 JSONObject（内包 data 数组），不能收 JSONArray——weex/fastjson 会把裸数组当 JSONObject 解析而失败。
//   声学唤醒占位（KWS 模型未集成前不触发 onWake；唤醒判定当前由网关 ASR + JS matchWakeWord 完成）：
//     start / stop / onWake / onError
//
// 注册：App.java 里 UniSDKEngine.registerUniModule("app-product-wake", WakeModule.class, false)。
// 非单例：JS 侧必须缓存 requireNativePlugin 返回的实例，否则 PCM 被投给各自独立的原生队列。
//
// 权限：AndroidManifest 声明 RECORD_AUDIO，且运行时权限由 JS 侧（uni.authorize scope.record）
//   在调用 startPcm 之前请求——uni-app 框架不会为原生 AudioRecord 代为请求，WXModule 也不保证
//   把 onRequestPermissionsResult 转发到本插件，故插件只做「检查 + 无权限回报」，不主动请求。

package com.xiaoxiong.assistant.wake;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.util.Log;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
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

    // ---- 采集状态 ----
    private AudioRecord recorder;
    /** 采集端 AEC：抵消扬声器外放的音乐/提示音/TTS 回声，避免被 ASR 识别成指令。 */
    private AcousticEchoCanceler aec;
    private Thread captureThread;
    private volatile boolean running = false;

    // ---- 播放状态（TTS PCM，原生 AudioTrack）----
    private AudioTrack playTrack;
    private volatile int playSampleRate = 24000;
    /** 已累计写入的帧数（1 帧 = 1 个 16bit 采样），用于判断播放头是否追上写入进度。 */
    private volatile long writtenFrames = 0;
    private volatile boolean playRunning = false;
    private Thread idlePollThread;
    /** 播空事件是否已通知前端：每次写入新 PCM 重置，播空后只通知一次。 */
    private volatile boolean idleNotified = true;
    private final Object playLock = new Object();

    // JS 侧注册的回调；keepAlive 模式可多次调用。
    private UniJSCallback pcmFrameCb;
    private UniJSCallback pcmErrorCb;
    private UniJSCallback wakeCb;
    private UniJSCallback wakeErrCb;
    private UniJSCallback playbackIdleCb;

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

    // ---- TTS PCM 播放接口（core/audio/appPlayback.ts 使用）----

    /** 注册「所有排队 PCM 播完」的回调，keepAlive 多次触发（每次播空一次）。 */
    @UniJSMethod(uiThread = false)
    public void onPlaybackIdle(UniJSCallback cb) {
        if (cb != null) {
            playbackIdleCb = cb;
            Log.i(TAG, "onPlaybackIdle registered");
        }
    }

    /** 起播：按网关下行采样率（24k）建 AudioTrack。重复调用会先停旧实例。 */
    @UniJSMethod(uiThread = false)
    public void startPlayback(int sampleRate) {
        Log.i(TAG, "startPlayback called, sampleRate=" + sampleRate);
        stopPlaybackInternal();
        playSampleRate = sampleRate > 0 ? sampleRate : 24000;
        try {
            int minBuf = AudioTrack.getMinBufferSize(
                    playSampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            // 缓冲至少 100ms，避免流式写入时被音频线程抢得太紧产生周期性卡顿。
            int bufSize = Math.max(minBuf, playSampleRate * CHANNELS * (BITS / 8) / 10);
            playTrack = new AudioTrack(
                    AudioManager.STREAM_MUSIC,
                    playSampleRate,
                    AudioFormat.CHANNEL_OUT_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufSize,
                    AudioTrack.MODE_STREAM);
            if (playTrack.getState() != AudioTrack.STATE_INITIALIZED) {
                Log.e(TAG, "AudioTrack init failed");
                playTrack.release();
                playTrack = null;
                return;
            }
            playTrack.play();
            synchronized (playLock) {
                writtenFrames = 0;
                idleNotified = true;
            }
            playRunning = true;
            startIdlePolling();
            Log.i(TAG, "AudioTrack started: " + playSampleRate + "Hz/mono/16bit, buf=" + bufSize);
        } catch (Throwable e) {
            Log.e(TAG, "startPlayback failed: " + e.getMessage(), e);
            playRunning = false;
            playTrack = null;
        }
    }

    /** JS 传 {data:[0–255 字节]}。必须包成 JSONObject：DCloud/weex 桥用 fastjson 解析参数，
     *  直接声明 JSONArray 会让以 '[' 开头的数组被当成 JSONObject 解析而抛
     *  `expect {, actual [`，playPcm 每帧静默失败（无声 + 卡在播报）。采集 startPcm 用 JSONObject 已验证可行。
     *
     *  真机血泪（第二层坑）：包成对象后 `arg.optJSONArray("data")` 仍可能返回 null——weex/fastjson
     *  在不同版本把 JS number[] 转成 JSONObject 时，data 字段实际是 java.util.List / Object[]，
     *  而不是 JSONArray（logcat 里 `Missing inline cache for java.lang.Object[] ... prepareArguments`）。
     *  只认 optJSONArray 会静默 return，导致从不 startPlayback（无声 + 卡在播报）。这里对三种类型都兼容。 */
    @UniJSMethod(uiThread = false)
    public void playPcm(JSONObject arg) {
        if (arg == null) {
            Log.w(TAG, "playPcm: arg=null");
            return;
        }
        Object raw = arg.opt("data");
        int n;
        byte[] pcm;
        if (raw instanceof JSONArray) {
            JSONArray ja = (JSONArray) raw;
            n = ja.length();
            pcm = new byte[n];
            for (int i = 0; i < n; i++) pcm[i] = (byte) (ja.optInt(i) & 0xff);
        } else if (raw instanceof java.util.List) {
            java.util.List<?> list = (java.util.List<?>) raw;
            n = list.size();
            pcm = new byte[n];
            for (int i = 0; i < n; i++) {
                Object v = list.get(i);
                int iv = (v instanceof Number)
                        ? ((Number) v).intValue()
                        : (int) Double.parseDouble(String.valueOf(v));
                pcm[i] = (byte) (iv & 0xff);
            }
        } else if (raw != null && raw.getClass().isArray()) {
            n = java.lang.reflect.Array.getLength(raw);
            pcm = new byte[n];
            for (int i = 0; i < n; i++) {
                Object v = java.lang.reflect.Array.get(raw, i);
                int iv = (v instanceof Number)
                        ? ((Number) v).intValue()
                        : (int) Double.parseDouble(String.valueOf(v));
                pcm[i] = (byte) (iv & 0xff);
            }
        } else {
            Log.w(TAG, "playPcm: data unsupported type=" + (raw == null ? "null" : raw.getClass().getName()));
            return;
        }
        if (n == 0) return;
        // 每轮首帧打一次，确认 data 真实类型与字节数，避免再次盲猜
        if (writtenFrames == 0) {
            Log.i(TAG, "playPcm first frame: dataCls=" + raw.getClass().getName() + " n=" + n + " b0=" + pcm[0]);
        }
        if (playTrack == null || !playRunning) startPlayback(playSampleRate);
        if (playTrack == null) return;
        int written = playTrack.write(pcm, 0, n);
        if (written > 0) {
            synchronized (playLock) {
                writtenFrames += written / 2;
                idleNotified = false;
            }
        }
    }

    @UniJSMethod(uiThread = false)
    public void stopPlayback() {
        Log.i(TAG, "stopPlayback called");
        stopPlaybackInternal();
    }

    /** 轮询播放头位置：追上已写入帧数即视作播空，回调前端对齐 tts.end 的播完回执。 */
    private void startIdlePolling() {
        if (idlePollThread != null) return;
        idlePollThread = new Thread(() -> {
            Log.i(TAG, "idle polling started");
            while (playRunning && playTrack != null) {
                long head = playTrack.getPlaybackHeadPosition() & 0xffffffffL;
                boolean notify = false;
                synchronized (playLock) {
                    if (!idleNotified && writtenFrames > 0 && head >= writtenFrames) {
                        idleNotified = true;
                        notify = true;
                    }
                }
                if (notify && playbackIdleCb != null) {
                    try {
                        playbackIdleCb.invokeAndKeepAlive(true);
                    } catch (Throwable ignored) {
                        // JS 已解绑，忽略
                    }
                }
                try {
                    Thread.sleep(20);
                } catch (InterruptedException e) {
                    break;
                }
            }
            Log.i(TAG, "idle polling ended");
        }, "wake-playback-idle");
        idlePollThread.start();
    }

    private void stopPlaybackInternal() {
        playRunning = false;
        if (idlePollThread != null) {
            idlePollThread.interrupt();
            try {
                idlePollThread.join(200);
            } catch (Throwable ignored) {
            }
            idlePollThread = null;
        }
        if (playTrack != null) {
            try {
                playTrack.stop();
                playTrack.release();
            } catch (Throwable ignored) {
            }
            playTrack = null;
        }
        synchronized (playLock) {
            writtenFrames = 0;
            idleNotified = true;
        }
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
            // VOICE_COMMUNICATION 是 Android 官方配合 AEC 的采集源：系统会把扬声器输出作为回声参考，
            // 抵消音乐/提示音/TTS 的外放回声，避免被 ASR 识别成「暂停/播放」等指令（H5 靠浏览器 AEC，
            // App 端必须用原生 AEC 才能达到同样效果）。设备不支持 AEC 时静默降级，功能不受影响。
            recorder = new AudioRecord(
                    MediaRecorder.AudioSource.VOICE_COMMUNICATION,
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
            try {
                if (AcousticEchoCanceler.isAvailable()) {
                    aec = AcousticEchoCanceler.create(recorder.getAudioSessionId());
                    if (aec != null) {
                        aec.setEnabled(true);
                        Log.i(TAG, "AcousticEchoCanceler enabled");
                    }
                } else {
                    Log.w(TAG, "AcousticEchoCanceler not available on this device");
                }
            } catch (Throwable e) {
                Log.w(TAG, "enable AEC failed: " + e.getMessage());
                aec = null;
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
                    // byte[] 经 DCloud 桥转成前端 number[]，appCapture.toArrayBuffer 兼容处理
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
        if (aec != null) {
            try {
                aec.setEnabled(false);
                aec.release();
            } catch (Throwable ignored) {
            }
            aec = null;
        }
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
