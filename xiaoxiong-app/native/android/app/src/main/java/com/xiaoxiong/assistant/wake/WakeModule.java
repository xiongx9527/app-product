// app-product-wake 原生插件（Android/DCloud 离线 SDK）。
//
// 为什么需要它：
//   uni-app 的 uni.getRecorderManager 在 App 端不支持 onFrameRecorded，拿不到实时 PCM 分片，
//   无法满足网关「16k/16bit/单声道 PCM 分片上行」契约。App 端的麦克风输入完全由本插件提供。
//
// 职责（与 JS 侧 appCapture.ts / appPlayback.ts / providers/native.ts 的接口一一对应）：
//   PCM 采集（对话/唤醒的音频来源）：startPcm / stopPcm / onPcmFrame / onPcmError
//   TTS 播放（App 逻辑层无 WebAudio，网关下发的 24k PCM 只能由原生 AudioTrack 播）：
//     startPlayback / playPcm({pcm:base64}) / stopPlayback / onPlaybackIdle
//   playPcm 必须收 {pcm:base64字符串}：weex 桥会丢弃 JS 对象里的数组字段（传空对象），
//   裸数组又以 '[' 开头被 fastjson 误判成 JSONObject；只有字符串标量能可靠过桥。
//   端侧 KWS 唤醒（sherpa-onnx zipformer 3.3M，随包离线）：start / stop / onWake / onError。
//     start 初始化 KeywordSpotter 并在采集循环里逐帧检测，命中经 onWake({word}) 回调 JS，
//     由 useAssistant.handleWakeHit 统一路由「唤醒 / 打断」；ASR 文本匹配保留作兜底。
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
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.content.res.AssetFileDescriptor;
import android.media.audiofx.AcousticEchoCanceler;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import io.dcloud.feature.uniapp.annotation.UniJSMethod;
import io.dcloud.feature.uniapp.bridge.UniJSCallback;
import io.dcloud.feature.uniapp.common.UniModule;

// sherpa-onnx 端侧 KWS（关键词唤醒）：见 docs/kws-wake-interrupt-plan.md
import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotter;
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig;
import com.k2fsa.sherpa.onnx.KeywordSpotterResult;
import com.k2fsa.sherpa.onnx.OnlineModelConfig;
import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig;

public class WakeModule extends UniModule {
    private static final String TAG = "WakeModule";
    /** 上行契约：16k / 16bit / 单声道 / 32ms 分片，与 contracts/README.md 一致。 */
    private static final int SAMPLE_RATE = 16000;
    private static final int CHANNELS = 1;
    private static final int BITS = 16;
    private static final int FRAME_MS = 32;
    /** 每多少帧打一次统计日志，避免刷屏。 */
    private static final int LOG_EVERY_FRAMES = 50;
    /** TTS 播报音量（0–1）：正常播报取清晰值，插话 duck 时压低但仍能听清。
     *  早先为治「播报期插话难」压到 0.2，但真凶是 weex keepAlive 回调在播报期失效
     *  （已用原生 PCM 直连修复），降音量并非解药、反让播报太小声，故调回清晰值。
     *  前端 useAssistant.ts 的 TTS_VOLUME_NORMAL/TTS_VOLUME_DUCK 须与此同步。 */
    private static final float PLAYBACK_VOLUME = 0.7f;
    /** duck 时压到的音量：必须够低，否则残余 TTS 回声盖住用户说话、ASR 把中文「停一下」识别成
     *  Yeah/Okay/The 等英文碎片并被当噪声过滤，插话文字就出不来（真机实锤：0.25 时全是英文碎片，
     *  0.05 时中文能识别）。用户开口瞬间压低、说完恢复 0.7，平时播报音量不受影响。 */
    private static final float DUCK_VOLUME = 0.05f;
    /** 当前播报音量（0–1），可被 duck 动态改写；起播时按此值 setVolume。 */
    private volatile float playbackVolume = PLAYBACK_VOLUME;

    public WakeModule() {
        Log.i(TAG, "WakeModule instantiated");
    }

    // 原生 PCM 直连网关上报（绕开播报期失效的 weex keepAlive 回调）
    private PcmUploader pcmUploader;

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
    /** 最后一帧写入时刻：head 追上 written 后还要静默确认，避免流式 TTS 帧间隙假播空
     *  （铁证：长播报 59 秒，idle 却在第 12 秒误触发 → 提前显示本轮完成并停播）。 */
    private volatile long lastFrameWriteMs = 0;
    private static final long IDLE_CONFIRM_MS = 600;
    private final Object playLock = new Object();

    // ---- 原生本地 barge-in duck ----
    // 为什么在原生做：网关 audio.duck 事件要经 weex 下行回 JS 再回调原生 setPlaybackVolume，
    // 而播报期 weex 回调被 TTS 下行冲击丢弃（与上行 PCM keepAlive 失效同一根因），duck 指令到不了。
    // 原生采集循环手里就有每帧 rms 和 playRunning，直接据此压/放 AudioTrack 音量，绕开整条不可靠链路。
    /** 人声能量阈值：超过就认定用户开口（与网关 FRAME 诊断 0.02 同量级） */
    private static final double LOCAL_DUCK_RMS = 0.02;
    /** 静音多久恢复播报音量 */
    private static final long LOCAL_DUCK_RELEASE_MS = 800;
    private volatile boolean localDucked = false;
    private volatile long lastVoiceMs = 0;

    // JS 侧注册的回调；keepAlive 模式可多次调用。
    private UniJSCallback pcmFrameCb;
    private UniJSCallback pcmErrorCb;
    private UniJSCallback wakeCb;
    private UniJSCallback wakeErrCb;
    private UniJSCallback playbackIdleCb;
    private UniJSCallback cueEndCb;

    // ---- 端侧 KWS（sherpa-onnx zipformer 3.3M，int8 随包）----
    // 常驻检测唤醒词，命中直接回调 wakeCb（{word}），唤醒判定不再等 ASR 整段转写。
    // 与 ASR 共用同一条 AudioRecord 采集（captureLoop 每帧喂一份给 KWS），不额外占麦克风。
    private KeywordSpotter kws;
    private OnlineStream kwsStream;
    private volatile boolean kwsEnabled = false;
    /** KWS 命中去抖：一次唤醒词可能在连续多帧重复命中，命中后静音 N ms 再允许下一次。 */
    private static final long KWS_REARM_MS = 1500;
    private volatile long lastKwsHitMs = 0;
    /** 模型在 assets 内的目录（相对 assets 根），由打包脚本从 native/kws/vendor 拷入 */
    private static final String KWS_ASSET_DIR = "kws/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01";

    // ---- 本地提示音播放（原生 MediaPlayer，不申请音频焦点）----
    // 为什么不用 uni.createInnerAudioContext：那条路底层 io.dcloud.feature.audio.AudioPlayer
    // 会 requestAudioFocus(AUDIOFOCUS_GAIN)，抢走正在播放音乐的 InnerAudioContext 的焦点，
    // 音乐被系统 pause 且不自动恢复（真机 logcat 已证实：abandonAudioFocus/requestAudioFocus
    // 均来自 AudioPlayer$1）。裸 MediaPlayer 默认不申请焦点，可与音乐并发出声；配合 JS 侧
    // duckMusic 压低音乐音量，即可对标 H5「提示音变小、音乐持续播、播完恢复」。
    private MediaPlayer cuePlayer;
    /** 提示音资源在 apk assets 内的前缀；mp3 打包时为 Stored（未压缩），可用 openFd 直接播。 */
    private static final String CUE_ASSET_PREFIX = "apps/__UNI__145C29C/www/static/audio/";

    // ---- PCM 采集接口（core/audio/appCapture.ts 使用）----

    /** 配置原生 PCM 直连上报：JS 把 deviceId 传进来，采集帧将同时经原生 WS 直发网关，
     *  绕开播报期失效的 weex keepAlive 回调。标量 String 参数可靠过桥。 */
    @UniJSMethod(uiThread = false)
    public void configureDirectUpload(String deviceId) {
        try {
            Context ctx = safeContext();
            if (ctx == null) return;
            pcmUploader = PcmUploader.get(ctx);
            // TTS 音频从这条原生连接下发：收到二进制帧直接写 AudioTrack，不经 JS——
            // 播报期 JS 线程被 TTS 处理占满会让 weex 回调（含 socket 文本下行）全失效。
            pcmUploader.setTtsFrameListener(new PcmUploader.TtsFrameListener() {
                @Override
                public void onTtsFrame(byte[] pcm) {
                    playPcmBytes(pcm);
                }
            });
            pcmUploader.configure(deviceId);
            Log.i(TAG, "configureDirectUpload called");
        } catch (Throwable e) {
            Log.w(TAG, "configureDirectUpload failed: " + e.getMessage());
        }
    }

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
        Log.i(TAG, "startPcm called, options=" + (options == null ? "null" : options.toString()));
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
        synchronized (playLock) {
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
            // 新句开始：清掉上一句的本地 duck 状态，从正常音量起播（第一帧若仍有人声会立刻再 duck）
            localDucked = false;
            applyPlaybackVolume();
            playTrack.play();
            writtenFrames = 0;
            idleNotified = true;
            lastFrameWriteMs = System.currentTimeMillis();
            playRunning = true;
            // 播报期关 AEC：真机实锤——TTS 一播放，AEC 双讲抑制把用户插话一起抵消成静音
            // （非播报期说话 rms 0.1 正常，播报期说话 rms 0.0000）。关掉后回声由网关文本层
            // resemblesSpoken 过滤，人声能被采进来识别。播完在 stopPlaybackInternal 恢复。
            setAecEnabled(false);
            startIdlePolling();
            Log.i(TAG, "AudioTrack started: " + playSampleRate + "Hz/mono/16bit, buf=" + bufSize
                    + ", volume=" + playbackVolume);
        } catch (Throwable e) {
            Log.e(TAG, "startPlayback failed: " + e.getMessage(), e);
            playRunning = false;
            playTrack = null;
        }
        }
    }

    /** barge-in duck：用户一开口就把播报音量压到接近 0，让麦克风只收到人声、ASR 识别准。
     *  标量 int 参数传 0–100 百分比：真机 weex 桥传 float 不可靠（从未进过这个方法），
     *  int 与 startPlayback(int) 同理可靠过桥；内部再 /100f。 */
    @UniJSMethod(uiThread = false)
    public void setPlaybackVolume(int percent) {
        playbackVolume = Math.max(0f, Math.min(1f, percent / 100f));
        applyPlaybackVolume();
        Log.i(TAG, "setPlaybackVolume: percent=" + percent + " volume=" + playbackVolume + " localDucked=" + localDucked);
    }

    /** 把当前音量应用到 AudioTrack：原生本地 duck 优先于 JS 设的 playbackVolume。
     *  setVolume 与 write/stop/release 同一把锁（AudioTrack 非线程安全）。 */
    private void applyPlaybackVolume() {
        synchronized (playLock) {
            if (playTrack == null) return;
            float v = localDucked ? DUCK_VOLUME : playbackVolume;
            try {
                playTrack.setVolume(v);
            } catch (Throwable ignored) {
            }
        }
    }

    /** JS 直接传 base64 字符串（不包对象）。真机血泪（四层坑，逐层挖出来）：
     *  ① 裸数组 playPcm(JSONArray)：以 '[' 开头被 fastjson 当 JSONObject 解析，抛 `expect {, actual [`；
     *  ② 包成 {data:number[]}：weex 桥把 JS 对象转 JSONObject 时丢掉数组字段，原生收到 `{}`；
     *  ③ 包成 {pcm:"base64"}：连字符串字段也一起丢，仍是 `{}`；
     *  ④ 正解：字符串直接作为方法参数 playPcm(String)，不包任何对象——标量参数才能可靠过桥。 */
    @UniJSMethod(uiThread = false)
    public void playPcm(String b64) {
        if (b64 == null || b64.length() == 0) {
            if (writtenFrames == 0) Log.w(TAG, "playPcm: empty b64 arg");
            return;
        }
        byte[] pcm;
        try {
            pcm = Base64.decode(b64, Base64.DEFAULT);
        } catch (Throwable e) {
            Log.e(TAG, "playPcm: base64 decode failed: " + e.getMessage());
            return;
        }
        if (pcm.length == 0) return;
        if (writtenFrames == 0) {
            Log.i(TAG, "playPcm first frame: b64len=" + b64.length() + " bytes=" + pcm.length + " b0=" + pcm[0]);
        }
        writePcmFrame(pcm);
    }

    /** TTS 音频原生直连入口（PcmUploader 从 role=pcm 连接收到 TTS 二进制帧时调用），
     *  不经 JS base64 解码——播报期 JS 线程被 TTS 处理占满会让 weex 回调全失效。 */
    public void playPcmBytes(byte[] pcm) {
        if (pcm == null || pcm.length == 0) return;
        if (writtenFrames == 0) {
            Log.i(TAG, "playPcmBytes first frame: bytes=" + pcm.length + " b0=" + pcm[0]);
        }
        writePcmFrame(pcm);
    }

    /** 把一帧 PCM 写进 AudioTrack（base64 路径与原生直连路径共用）。
     *  AudioTrack 非线程安全：playPcmBytes 走 OkHttp 线程、idle/stop 走其它线程，
     *  create/play/write/stop/release/setVolume/getPosition 必须同一把锁，否则 native abort(signal 6)。 */
    private void writePcmFrame(byte[] pcm) {
        synchronized (playLock) {
            if (playTrack == null || !playRunning) startPlayback(playSampleRate);
            if (playTrack == null) return;
            int written = playTrack.write(pcm, 0, pcm.length);
            if (written > 0) {
                writtenFrames += written / 2;
                idleNotified = false;
                lastFrameWriteMs = System.currentTimeMillis();
            }
        }
    }

    @UniJSMethod(uiThread = false)
    public void stopPlayback() {
        Log.i(TAG, "stopPlayback called");
        stopPlaybackInternal();
    }

    // ---- 本地提示音播放接口（core/audio/promptPlayer.ts 使用）----

    /** 注册提示音播放结束回调（自然播完 / 出错 / 被 stop 都回调一次，带是否自然播完）。 */
    @UniJSMethod(uiThread = false)
    public void onCueEnd(UniJSCallback cb) {
        if (cb != null) {
            cueEndCb = cb;
            Log.i(TAG, "onCueEnd registered");
        }
    }

    /** 播放一个打包内提示音。file 为文件名（如 greeting.mp3），内部拼 assets 前缀。
     *  裸 MediaPlayer 不申请音频焦点，音乐 InnerAudioContext 不会被暂停；音量交给 JS duckMusic。 */
    @UniJSMethod(uiThread = false)
    public void playCue(String file) {
        if (file == null || file.length() == 0) {
            Log.w(TAG, "playCue: empty file arg");
            return;
        }
        Context ctx = safeContext();
        if (ctx == null) {
            Log.e(TAG, "playCue: no context");
            notifyCueEnd(false);
            return;
        }
        stopCueInternal();
        try {
            String path = CUE_ASSET_PREFIX + file;
            AssetFileDescriptor afd = ctx.getAssets().openFd(path);
            cuePlayer = new MediaPlayer();
            cuePlayer.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            // STREAM_MUSIC：与音乐同一流，duck 时同为媒体音量；裸 MediaPlayer 主动不调
            // requestAudioFocus，系统不会因它 pause 掉持有焦点的音乐播放器。
            cuePlayer.setAudioStreamType(AudioManager.STREAM_MUSIC);
            cuePlayer.setVolume(1.0f, 1.0f);
            cuePlayer.setOnCompletionListener(mp -> {
                Log.i(TAG, "cue completed: " + file);
                stopCueInternal();
                notifyCueEnd(true);
            });
            cuePlayer.setOnErrorListener((mp, what, extra) -> {
                Log.e(TAG, "cue error: " + file + " what=" + what + " extra=" + extra);
                stopCueInternal();
                notifyCueEnd(false);
                return true;
            });
            cuePlayer.prepare();
            cuePlayer.start();
            Log.i(TAG, "cue started: " + file);
        } catch (Throwable e) {
            Log.e(TAG, "playCue failed: " + file + " -> " + e.getMessage(), e);
            stopCueInternal();
            notifyCueEnd(false);
        }
    }

    /** 打断当前提示音（新一轮提示 / 会话结束时）。 */
    @UniJSMethod(uiThread = false)
    public void stopCue() {
        Log.i(TAG, "stopCue called");
        stopCueInternal();
    }

    private void stopCueInternal() {
        if (cuePlayer != null) {
            try {
                if (cuePlayer.isPlaying()) cuePlayer.stop();
                cuePlayer.reset();
                cuePlayer.release();
            } catch (Throwable ignored) {
            }
            cuePlayer = null;
        }
    }

    private void notifyCueEnd(boolean completed) {
        if (cueEndCb != null) {
            try {
                cueEndCb.invokeAndKeepAlive(completed);
            } catch (Throwable ignored) {
                // JS 已解绑，忽略
            }
        }
    }

    /** 轮询播放头位置：追上已写入帧数即视作播空，回调前端对齐 tts.end 的播完回执。 */
    private void startIdlePolling() {
        if (idlePollThread != null) return;
        idlePollThread = new Thread(() -> {
            Log.i(TAG, "idle polling started");
            while (true) {
                // getPlaybackHeadPosition 必须与 write/stop/release 同一把锁（AudioTrack 非线程安全）
                boolean notify = false;
                synchronized (playLock) {
                    if (!playRunning || playTrack == null) break;
                    long head = playTrack.getPlaybackHeadPosition() & 0xffffffffL;
                    // head 追上 written 且距最后一帧已静默 IDLE_CONFIRM_MS，才算真播空。
                    // 否则流式 TTS 帧间隙 head 会短暂追上 written，误判播空→提前回执→提前显示完成并停播。
                    if (!idleNotified && writtenFrames > 0 && head >= writtenFrames
                            && (System.currentTimeMillis() - lastFrameWriteMs) >= IDLE_CONFIRM_MS) {
                        idleNotified = true;
                        notify = true;
                    }
                }
                if (notify) {
                    // 真正播空（扬声器不再外放 TTS）：恢复 AEC。若队列马上有下一句，
                    // startPlayback 会再关掉；这里的短暂恢复无副作用。
                    setAecEnabled(true);
                    // 播完回执优先走原生直连（不经 weex）：铁证 playbackIdleCb 走 weex 在播报期
                    // 丢失，客户端只能靠 12s 兜底。这条经 role=pcm 可靠到网关。
                    if (pcmUploader != null) {
                        pcmUploader.sendText("{\"type\":\"session.playback_done\"}");
                    }
                    if (playbackIdleCb != null) {
                        try {
                            playbackIdleCb.invokeAndKeepAlive(true);
                        } catch (Throwable ignored) {
                            // JS 已解绑，忽略
                        }
                    }
                    // 播空后在此线程内自行复位播报态：playRunning 之前只在 stopPlaybackInternal 复位，
                    // 而原生直连路径下前端的 stopPlayback 打在另一个非单例实例上是 no-op，导致
                    // playRunning 长期卡 true（真机 PCM-DIAG 播完仍 play=true、采集被消音、插话采不到）。
                    // 这里复位后 while 下一轮 411 行自然 break；下一句首帧经 writePcmFrame 的
                    // `playTrack==null || !playRunning` 判断自动重建 AudioTrack，不误伤多句播报。
                    finishPlaybackFromIdle();
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

    /** 播空后由 idle polling 线程自行复位：不调 stopPlaybackInternal（它会 interrupt+join
     *  本线程，自等卡死），只置 playRunning=false、停/释放 playTrack、恢复 AEC。 */
    private void finishPlaybackFromIdle() {
        synchronized (playLock) {
            playRunning = false;
            localDucked = false;
            if (playTrack != null) {
                try {
                    playTrack.stop();
                    playTrack.release();
                } catch (Throwable ignored) {
                }
                playTrack = null;
            }
            writtenFrames = 0;
            idleNotified = true;
            lastFrameWriteMs = 0;
        }
        setAecEnabled(true);
        Log.i(TAG, "playback finished from idle, playRunning=false, AEC restored");
    }

    private void stopPlaybackInternal() {
        playRunning = false;
        localDucked = false;
        if (idlePollThread != null) {
            idlePollThread.interrupt();
            try {
                idlePollThread.join(200);
            } catch (Throwable ignored) {
            }
            idlePollThread = null;
        }
        synchronized (playLock) {
            if (playTrack != null) {
                try {
                    playTrack.stop();
                    playTrack.release();
                } catch (Throwable ignored) {
                }
                playTrack = null;
            }
            writtenFrames = 0;
            idleNotified = true;
            lastFrameWriteMs = 0;
        }
        // 停止播放：恢复 AEC（停在 duck 关闭态时兜底；正常播空路径在 idle polling 里已恢复）
        setAecEnabled(true);
    }

    /** 开/关采集端 AEC（播报期关、播完开）。aec 可能为 null（设备不支持/采集未启动），静默忽略。 */
    private void setAecEnabled(boolean enabled) {
        if (aec == null) return;
        try {
            boolean cur = aec.getEnabled();
            if (cur != enabled) {
                aec.setEnabled(enabled);
                Log.i(TAG, "AEC setEnabled: " + enabled + " (playRunning=" + playRunning + ")");
            }
        } catch (Throwable ignored) {
        }
    }

    // ---- 声学唤醒接口（providers/native.ts 使用）----

    @UniJSMethod(uiThread = false)
    public void start(JSONObject options, UniJSCallback cb) {
        // 采集是 ASR 与 KWS 共用的：先确保 AudioRecord 在跑，再开 KWS 引擎。
        startCapture();
        initKws();
        kwsEnabled = (kws != null);
        Log.i(TAG, "KWS start: " + (kwsEnabled ? "ok" : "unavailable (ASR 文本兜底继续)"));
    }

    @UniJSMethod(uiThread = false)
    public void stop() {
        kwsEnabled = false;
        // 注意：这里不 stopCapture——采集由 startPcm/stopPcm 独立管理（ASR 仍要用）。
        // KWS stop 只是停止「喂帧检测」，引擎保留以便快速重启。
    }

    /** 初始化 sherpa-onnx KeywordSpotter：模型与 keywords.txt 从 assets 加载（随包、离线）。 */
    private synchronized void initKws() {
        if (kws != null) return;
        Context ctx = safeContext();
        if (ctx == null) return;
        try {
            FeatureConfig feat = new FeatureConfig();
            feat.setSampleRate(SAMPLE_RATE);
            feat.setFeatureDim(80);

            OnlineTransducerModelConfig transducer = new OnlineTransducerModelConfig();
            transducer.setEncoder(KWS_ASSET_DIR + "/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
            transducer.setDecoder(KWS_ASSET_DIR + "/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
            transducer.setJoiner(KWS_ASSET_DIR + "/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx");

            OnlineModelConfig model = new OnlineModelConfig();
            model.setTransducer(transducer);
            model.setTokens(KWS_ASSET_DIR + "/tokens.txt");
            model.setModelType("zipformer2");

            KeywordSpotterConfig cfg = new KeywordSpotterConfig();
            cfg.setFeatConfig(feat);
            cfg.setModelConfig(model);
            cfg.setKeywordsFile(KWS_ASSET_DIR + "/keywords.txt");
            cfg.setMaxActivePaths(4);
            cfg.setKeywordsScore(1.5f);
            cfg.setKeywordsThreshold(0.25f);

            kws = new KeywordSpotter(ctx.getAssets(), cfg);
            kwsStream = kws.createStream("");
            Log.i(TAG, "KeywordSpotter initialized from assets");
        } catch (Throwable e) {
            Log.w(TAG, "KWS init failed (fallback to ASR text): " + e.getMessage());
            kws = null;
            kwsStream = null;
        }
    }

    /** 把一帧 16bit PCM 转成 float[] 喂给 KWS 并检测命中。在采集线程调用。 */
    private void feedKws(byte[] frame) {
        if (!kwsEnabled || kws == null || kwsStream == null) return;
        try {
            int n = frame.length / 2;
            float[] samples = new float[n];
            for (int i = 0, j = 0; i < frame.length; i += 2, j += 1) {
                samples[j] = (short) (((frame[i + 1] & 0xff) << 8) | (frame[i] & 0xff)) / 32768.0f;
            }
            kwsStream.acceptWaveform(samples, SAMPLE_RATE);
            while (kws.isReady(kwsStream)) {
                kws.decode(kwsStream);
                KeywordSpotterResult result = kws.getResult(kwsStream);
                String keyword = result == null ? null : result.getKeyword();
                if (keyword != null && !keyword.isEmpty()) {
                    long now = System.currentTimeMillis();
                    if (now - lastKwsHitMs >= KWS_REARM_MS) {
                        lastKwsHitMs = now;
                        Log.i(TAG, "KWS HIT: " + keyword);
                        if (wakeCb != null) {
                            try {
                                java.util.Map<String, Object> payload = new java.util.HashMap<>();
                                payload.put("word", keyword);
                                wakeCb.invokeAndKeepAlive(new org.json.JSONObject(payload));
                            } catch (Throwable ignored) { }
                        }
                    }
                    kws.reset(kwsStream);  // 命中后重置，准备下一次检测
                }
            }
        } catch (Throwable e) {
            Log.w(TAG, "feedKws error: " + e.getMessage());
        }
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
        long diagAt = 0;
        // 临时诊断：记录采集端（AEC 处理后）的原始帧能量，定位「播报期上行没声音」是采集端还是发送端
        final long DIAG_EVERY_MS = 400;
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
            long nowMs = System.currentTimeMillis();
            // 每帧算 rms（int16 平方和，开销极小）：既供诊断，也供原生本地 duck。
            double sum = 0;
            for (int i = 0; i + 1 < read; i += 2) {
                int s = (short) (((frame[i + 1] & 0xff) << 8) | (frame[i] & 0xff));
                sum += (double) s * s;
            }
            double rms = Math.sqrt(sum / (read / 2)) / 32768.0;
            if (nowMs - diagAt >= DIAG_EVERY_MS) {
                diagAt = nowMs;
                Log.i(TAG, "PCM-DIAG rms=" + String.format("%.4f", rms) + " play=" + playRunning);
            }
            // 端侧 KWS：每帧喂一份给关键词检测（与 ASR 共用这条 AEC 后的采集）。
            // 播报期的回声已由 AEC 抵消，命中即回调 JS（word），由 handleWakeHit 统一路由/节流。
            feedKws(frame);
            // 原生本地 duck：播报期检测到真人开口就压低 TTS，静音超时恢复。
            // 只在 playRunning 时生效，不碰非播报期；按时间戳去抖，避免每帧 setVolume 刷屏。
            if (playRunning) {
                if (rms > LOCAL_DUCK_RMS) lastVoiceMs = nowMs;
                boolean shouldDuck = (nowMs - lastVoiceMs) < LOCAL_DUCK_RELEASE_MS;
                if (shouldDuck != localDucked) {
                    localDucked = shouldDuck;
                    applyPlaybackVolume();
                    Log.i(TAG, "LOCAL-DUCK " + (localDucked ? "on" : "off") + " rms=" + String.format("%.4f", rms));
                }
            }
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
            // 原生 PCM 直连网关：只在播报期（weex 回调失效）启用，补上 JS 收不到的帧；
            // 非播报期 weex 回调正常，仍由 JS 主连接发送，避免两路重复导致 ASR 收到重叠音频。
            if (pcmUploader != null && playRunning) {
                pcmUploader.upload(frame.clone());
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

    /**
     * 稳定设备标识：ANDROID_ID（Settings.Secure.ANDROID_ID）。
     * 签名不变时卸载重装不变、无需权限——替代 JS 侧自生成 UUID（存 storage，卸载即变）。
     * 恢复出厂设置后会变、部分 ROM 可能按签名隔离，但这是 Android 无账号体系下最可靠的标识。
     * 读取失败返回空串，JS 侧回退到旧的 storage UUID 方案。
     */
    @UniJSMethod(uiThread = false)
    public String getStableDeviceId() {
        try {
            Context ctx = safeContext();
            if (ctx == null) return "";
            String id = android.provider.Settings.Secure.getString(
                    ctx.getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
            return id == null ? "" : id;
        } catch (Throwable e) {
            Log.w(TAG, "getStableDeviceId failed: " + e.getMessage());
            return "";
        }
    }

}
