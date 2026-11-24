//
//  AppProductWakeModule.m
//  app-product-wake 原生插件（iOS）—— PCM 采集，参照 Android WakeModule.java
//
//  音频链路：AVAudioEngine 麦克风 → installTap（16k/mono/float32）→ 转 int16 PCM
//            → 每 512 sample（32ms）= 1024 字节 → UniModuleKeepAliveCallback 回调 JS
//            → JS transport 送网关（JS 回调透传方案）
//

#import "AppProductWakeModule.h"
#import "KwsEngine.h"
#import "PcmUploader.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <UIKit/UIKit.h>
#import <math.h>

static NSString *const kTag = @"[app-product-wake]";

/** 上行契约：16k / 16bit / 单声道 / 32ms。 */
static const NSInteger kSampleRate = 16000;
static const NSInteger kChannels = 1;
static const NSInteger kBits = 16;
static const NSInteger kFrameMs = 32;
/** 每帧采样数 = 16000 * 0.032 = 512；每帧字节 = 512 * 2 = 1024。 */
static const NSInteger kFrameSamples = 512;
/** iOS AVAudioEngine(VoiceChat) 采集幅度偏小（实测 rms~0.002，正常近场应 0.01~0.11），
 *  经网关 VAD 绝对下限 0.008 会被全当静音丢弃 → ASR 收不到音频。这里放大到正常范围。 */
static const float kInputGain = 12.0f;
/** KWS 专用增益：12x 会把说话峰值削成方波、声学特征失真导致唤醒词难命中；
 *  用 6x 温和放大（原始 rms~0.002→0.012 达可用范围）且钳位到±0.95 避免满幅削波。 */
static const float kKwsGain = 6.0f;
static const NSInteger kFrameBytes = 1024;

@interface AppProductWakeModule () <AVAudioPlayerDelegate, PcmUploaderTtsListener> {
    AVAudioEngine *_engine;
    BOOL _running;
    NSString *_deviceId;
    UniModuleKeepAliveCallback _pcmFrameCb;
    UniModuleKeepAliveCallback _pcmErrorCb;
    UniModuleKeepAliveCallback _wakeCb;      // KWS 唤醒词命中回调（JS onWake）
    UniModuleKeepAliveCallback _kwsErrorCb;  // KWS 引擎错误回调（JS onError）
    KwsEngine *_kwsEngine;      // 常驻 KWS（sherpa-onnx），复用 PCM 帧喂入
    AVAudioPlayer *_cuePlayer;  // 提示音播放（复用采集会话，避免 InnerAudioContext 抢 category）
    UniModuleKeepAliveCallback _cueEndCb; // 提示音播完回调 JS
    NSMutableData *_carry;      // 不足一帧的残留字节
    NSInteger _frameCount;
    double _inputSampleRate;    // inputNode 实际采样率（可能非 16k，onPcmBuffer 里重采样）
    // 原生 PCM 直连 + TTS 播放（对标 Android PcmUploader + AudioTrack）
    PcmUploader *_pcmUploader;
    AudioQueueRef _ttsQueue;
    NSMutableData *_ttsBuffer;  // TTS PCM 环形缓冲
    NSLock *_ttsLock;
    BOOL _ttsHasData;           // 是否收过 TTS 数据（避免空流误判 idle）
    NSTimeInterval _ttsLastDataAt; // 最后一次收到 TTS 数据的时间
    UniModuleKeepAliveCallback _playbackIdleCb; // 播空回调 JS
    BOOL _playRunning;          // 是否正在播报（直连上传门控用）
    BOOL _mediaPlaying;         // 媒体播放器(音乐/新闻 InnerAudioContext)是否在播——其声音不经网关TTS、无AEC参考，必须静音上行防被识别
    NSTimeInterval _soundTailMuteUntil; // 播报/提示音结束后的尾巴静音截止（覆盖扬声器余音，防回声自激）
    dispatch_queue_t _ttsIdleQueue;  // 播空检测定时器队列（串行，独立于采集/WS 线程）
    dispatch_source_t _ttsIdleTimer; // 播空检测定时器（见 startTtsIdleTimer）
    BOOL _standbyMuted;         // 待唤醒态：上行全静音（唤醒前不调 ASR），KWS 照常听
    // 【2026-11-24 两端统一 duck】中断前 duck：播报期检测人声开口压 TTS(AudioQueue) 给 KWS 让路
    BOOL _duckEnabled;          // 中断前 duck 开关（默认开）
    float _duckVolume;          // duck 时压到的音量（0-1，设置页强度档位，缺省 0.35）
    BOOL _localDucked;          // 当前是否处于 duck 态
    NSTimeInterval _lastVoiceMs; // 最近一次检测到人声的时刻（秒）
    BOOL _bargeInEnabled;       // 插话开关（预留：开则播报期上行真实帧）
    float _basePlaybackVolume;  // 设置页设的基础播报音量（duck 恢复回到它，缺省 1.0）
    UniModuleKeepAliveCallback _readyCb; // KWS 就绪回调（JS onReady）
    // 【2026-11-23 修熄屏唤醒】采集"意图"与实际运行状态分离：
    // _wantRunning=用户/JS 希望常驻采集（startPcm=YES, stopPcm=NO）；_running=AVAudioEngine 当前真的在跑。
    // 熄屏/音频中断/会话被保活抢占会让引擎 tap 停摆（_running 可能还是 YES 但再无帧），
    // 只要 _wantRunning 为真就必须自动把采集重建起来，不能再"一次启动管终身"。
    BOOL _wantRunning;
    NSTimeInterval _lastFrameAt;     // 最近一次 tap 回调时间，用于识别"引擎还在但不出帧"的停摆
    NSUInteger _restartGeneration;   // 重启请求代次，防止多次监听叠加导致重复/过期重启
    dispatch_queue_t _captureEventQueue; // 采集恢复专用串行队列（不占 JS/WS 线程）
    dispatch_source_t _captureWatchdog;  // 2s 巡检：引擎停摆则重启（后台 native 线程仍可跑）
}
@end

@implementation AppProductWakeModule

- (instancetype)init {
    self = [super init];
    if (self) {
        _carry = [NSMutableData data];
        _running = NO;
        _frameCount = 0;
        _ttsBuffer = [NSMutableData data];
        _ttsLock = [[NSLock alloc] init];
        _ttsHasData = NO;
        _playRunning = NO;
        // 两端统一 duck：默认开、强度 0.35、插话默认关
        _duckEnabled = YES;
        _duckVolume = 0.35f;
        _localDucked = NO;
        _lastVoiceMs = 0;
        _bargeInEnabled = NO;
        _basePlaybackVolume = 1.0f;
        _ttsIdleQueue = dispatch_queue_create("com.xiaoxiong.tts.idle", DISPATCH_QUEUE_SERIAL);
        // 采集自愈基础设施（常驻，不依赖 JS 是否被后台冻结）
        _wantRunning = NO;
        _lastFrameAt = 0;
        _restartGeneration = 0;
        _captureEventQueue = dispatch_queue_create("com.xiaoxiong.capture.event", DISPATCH_QUEUE_SERIAL);
        NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
        [nc addObserver:self selector:@selector(handleAudioInterruption:) name:AVAudioSessionInterruptionNotification object:nil];
        [nc addObserver:self selector:@selector(handleMediaServicesReset:) name:AVAudioSessionMediaServicesWereResetNotification object:nil];
        [nc addObserver:self selector:@selector(handleEngineConfigChange:) name:AVAudioEngineConfigurationChangeNotification object:nil];
        [nc addObserver:self selector:@selector(handleAppDidBecomeActive:) name:UIApplicationDidBecomeActiveNotification object:nil];
        [self startCaptureWatchdog];
    }
    return self;
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
    [self stopCaptureWatchdog];
    [self stopCueInternal];
    [_kwsEngine stop];
    _kwsEngine = nil;
    [self stopTtsQueueInternal];
    [_pcmUploader stop];
}

#pragma mark - 权限

/**
 * 点击开始采集时按需请求麦克风权限（不在冷启动弹框）。
 *
 * 为什么不靠 JS 的 uni.authorize('scope.record')：那个 scope 是 Android 口径，
 * 在本 App 的 iOS 自定义基座上不触发系统麦克风弹框（真机实测从没弹过、TCC 无麦克风请求记录、
 * 设置→隐私→麦克风里找不到本 App），导致 AVCaptureDevice 状态永远 notDetermined，
 * 一启动采集就报 MIC_NOT_DETERMINED。权限必须在原生侧用 AVCaptureDevice 主动请求。
 *
 * completion 在所有分支都会被调用（已授权/notDetermined 授权或拒绝/明确拒绝），
 * 且一定切回主线程；调用方据此决定是否继续真正启动采集。
 */
- (void)requestMicPermissionWithCompletion:(void (^)(BOOL granted))completion {
    AVAuthorizationStatus st = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (st == AVAuthorizationStatusAuthorized) {
        NSLog(@"%@ 麦克风权限已授权", kTag);
        if (completion) completion(YES);
        return;
    }
    if (st == AVAuthorizationStatusNotDetermined) {
        // 首次：主动弹系统授权框（iOS 标准做法，点击开始时触发）
        NSLog(@"%@ 麦克风权限未定，主动请求系统授权", kTag);
        __weak typeof(self) weakSelf = self;
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (granted) {
                    NSLog(@"%@ 麦克风授权成功", kTag);
                    if (completion) completion(YES);
                } else {
                    NSLog(@"%@ 麦克风授权被拒", kTag);
                    [weakSelf emitError:@"NEED_PERMISSION"];
                    if (completion) completion(NO);
                }
            });
        }];
        return;
    }
    // denied / restricted：系统设置里明确拒绝或受限。
    NSLog(@"%@ 麦克风权限不可用 status=%ld", kTag, (long)st);
    [self emitError:@"NEED_PERMISSION"];
    if (completion) completion(NO);
}

#pragma mark - JS 导出方法

// DCloud 宏 UNI_EXPORT_METHOD(sel) 需与方法实现分开写：宏参数只放 selector（带冒号），
// 用于向引擎登记可调用方法名；方法体单独实现。

/** JS 把 deviceId 传入。JS 回调透传模式下仅记录，不原生直连。 */
UNI_EXPORT_METHOD(@selector(configureDirectUpload:))
- (void)configureDirectUpload:(NSString *)deviceId {
    _deviceId = deviceId ?: @"";
    NSLog(@"%@ configureDirectUpload deviceIdLen=%lu", kTag, (unsigned long)_deviceId.length);
    // 开启原生 PCM 直连网关（绕开 weex 桥），TTS 下行帧走 ttsListener 原生播放
    if (!_pcmUploader) {
        _pcmUploader = [PcmUploader shared];
        _pcmUploader.ttsListener = self;
    }
    [_pcmUploader configure:_deviceId];
}

#pragma mark - PcmUploaderTtsListener

/// 网关下发的 TTS 音频帧（24k int16 mono）：写入播放缓冲，原生 AudioQueue 播放
- (void)onTtsFrame:(NSData *)pcm {
    if (!pcm || pcm.length == 0) return;
    [_ttsLock lock];
    [_ttsBuffer appendData:pcm];
    _ttsHasData = YES;
    _ttsLastDataAt = CFAbsoluteTimeGetCurrent();
    [_ttsLock unlock];
    [self ensureTtsQueue];
}

/// 网关下发的文本控制帧（备用）：透传给 JS
- (void)onTextFrame:(NSString *)text {
    // role=pcm 下行文本目前无用途（playback_done 是上行），预留透传
    NSLog(@"%@ role=pcm text frame: %@", kTag, text);
}

UNI_EXPORT_METHOD(@selector(onPcmFrame:))
- (void)onPcmFrame:(UniModuleKeepAliveCallback)callback {
    if (callback) {
        _pcmFrameCb = [callback copy];
        NSLog(@"%@ onPcmFrame registered", kTag);
    }
}

UNI_EXPORT_METHOD(@selector(onPcmError:))
- (void)onPcmError:(UniModuleKeepAliveCallback)callback {
    if (callback) _pcmErrorCb = [callback copy];
}

UNI_EXPORT_METHOD(@selector(startPcm:))
- (void)startPcm:(NSDictionary *)options {
    NSLog(@"%@ startPcm options=%@", kTag, options);
    [self startCapture];
}

UNI_EXPORT_METHOD(@selector(stopPcm))
- (void)stopPcm {
    NSLog(@"%@ stopPcm", kTag);
    [self stopCapture];
}

/// 【唤醒后保持亮屏】JS 在进入对话时调 YES、回待唤醒/退出时调 NO。
/// iOS 熄屏后 App 进后台即便有 audio 保活，长时间高 CPU（KWS 推理+采集+内嵌网关）
/// 仍会触发系统 task_exceeded_cpulimit 杀进程（真机铁证 2026-11-23）→ 用户体感「崩了」。
/// 唤醒后禁用 idleTimer 让屏幕常亮，对话期间保持在前台，绕开后台 CPU 限制；
/// 对话结束务必恢复 NO，否则永远不熄屏、耗电。
UNI_EXPORT_METHOD(@selector(keepScreenOn:))
- (void)keepScreenOn:(BOOL)on {
    [UIApplication sharedApplication].idleTimerDisabled = on;
    NSLog(@"%@ keepScreenOn=%d", kTag, on);
}

/// 【2026-11-23 修媒体播放声音被识别】音乐/新闻走 InnerAudioContext 外放，不经网关 TTS、
/// 网关 AEC 拿不到参考信号、消不掉回声。媒体播放期间必须静音上行（KWS 仍喂原始帧可唤醒）。
UNI_EXPORT_METHOD(@selector(setMediaPlaying:))
- (void)setMediaPlaying:(BOOL)on {
    _mediaPlaying = on;
    NSLog(@"%@ setMediaPlaying=%d", kTag, on);
}

/// 【修熄屏唤醒】JS 回前台/检测到采集停摆时调用：若用户仍希望采集(_wantRunning)，
/// 强制拆建 AVAudioEngine 重装 tap，恢复熄屏期间被系统掐断的麦克风采集。
/// 不存在"重复启动"副作用：幂等，且只作用于仍处在采集意图态的实例。
UNI_EXPORT_METHOD(@selector(ensureCapture))
- (void)ensureCapture {
    NSLog(@"%@ ensureCapture want=%d running=%d", kTag, _wantRunning, _running);
    if (!_wantRunning) return;
    // JS 主动调用一律强制重建：真机上存在"engine.isRunning=YES 但 tap 早已不出帧"的
    // 僵尸态，只靠健康检查会误判为正常。
    [self scheduleCaptureRestart:@"ensureCapture(JS)" force:YES];
}

#pragma mark - KWS 常驻唤醒（sherpa-onnx）

UNI_EXPORT_METHOD(@selector(onWake:))
- (void)onWake:(UniModuleKeepAliveCallback)callback {
    if (callback) _wakeCb = [callback copy];
    NSLog(@"%@ onWake registered", kTag);
}

UNI_EXPORT_METHOD(@selector(onError:))
- (void)onError:(UniModuleKeepAliveCallback)callback {
    if (callback) _kwsErrorCb = [callback copy];
}

UNI_EXPORT_METHOD(@selector(onReady:))
- (void)onReady:(UniModuleKeepAliveCallback)callback {
    if (callback) _readyCb = [callback copy];
    // 若 KWS 已加载完成（start 早于 onReady 注册），立即兑现就绪态
    if (_kwsEngine && _kwsEngine.ready) {
        @try { _readyCb(@YES, YES); } @catch (NSException *e) {}
    }
}

UNI_EXPORT_METHOD(@selector(setStandbyMuted:))
- (void)setStandbyMuted:(BOOL)muted {
    // 【2026-11-24 统一门控】_standbyMuted 现是前端 isAsrMuted() 的统一判定结果：
    // 待唤醒 + thinking/replying/speaking 都为 true（静音上行），listening/done 为 false。
    // 「哪几种阶段静音」的规则只在前端 useAssistant.ts 的 isAsrMuted() 一处定义，改那里即可。
    // 本原生层不再另立规则，只保留 _playRunning/提示音/尾音这些瞬时物理状态兜底。
    _standbyMuted = muted;
    NSLog(@"%@ setStandbyMuted=%d", kTag, muted);
}

UNI_EXPORT_METHOD(@selector(start:))
- (void)start:(NSDictionary *)options {
    NSLog(@"%@ KWS start options=%@", kTag, options);
    if (!_kwsEngine) {
        _kwsEngine = [[KwsEngine alloc] initWithWakeWord:@"你好小熊" bundle:[NSBundle mainBundle]];
        __weak typeof(self) weakSelf = self;
        _kwsEngine.onWake = ^(NSString *word) {
            __strong typeof(weakSelf) strongSelf = weakSelf;
            UniModuleKeepAliveCallback cb = strongSelf->_wakeCb;
            if (cb) cb(@{ @"word": word ?: @"你好小熊" }, YES); // keepAlive，对标 Android invokeAndKeepAlive
        };
        _kwsEngine.onError = ^(NSString *msg) {
            __strong typeof(weakSelf) strongSelf = weakSelf;
            UniModuleKeepAliveCallback cb = strongSelf->_kwsErrorCb;
            if (cb) cb(msg ?: @"KWS 异常", YES);
        };
        _kwsEngine.onReady = ^(BOOL ready) {
            __strong typeof(weakSelf) strongSelf = weakSelf;
            UniModuleKeepAliveCallback cb = strongSelf->_readyCb;
            if (cb) cb(@(ready), YES);
        };
    }
    // 后台加载模型（1-3s），不阻塞 JS 线程；失败经 onError 上报、成功经 onReady 上报，不崩
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        NSError *err = nil;
        BOOL ok = [self->_kwsEngine startWithError:&err];
        if (!ok) {
            NSLog(@"%@ KWS 启动失败: %@", kTag, err.localizedDescription);
            void (^cb)(id, BOOL) = self->_kwsErrorCb;
            if (cb) dispatch_async(dispatch_get_main_queue(), ^{ cb(err.localizedDescription ?: @"KWS 启动失败", YES); });
            // 同时兑现「未就绪」：界面据此提示「语音唤醒不可用，请点圆球」，
            // 否则 JS 侧永远停在 loading，用户会以为只是还在加载、一直白喊。
            UniModuleKeepAliveCallback readyCb = self->_readyCb;
            if (readyCb) dispatch_async(dispatch_get_main_queue(), ^{
                @try { readyCb(@NO, YES); } @catch (NSException *e) {}
            });
        }
    });
}

UNI_EXPORT_METHOD(@selector(stop))
- (void)stop {
    NSLog(@"%@ KWS stop", kTag);
    [_kwsEngine stop];
}

#pragma mark - 提示音播放（原生，复用采集会话）

UNI_EXPORT_METHOD(@selector(onCueEnd:))
- (void)onCueEnd:(UniModuleKeepAliveCallback)callback {
    if (callback) _cueEndCb = [callback copy];
}

UNI_EXPORT_METHOD(@selector(playCue:))
- (void)playCue:(NSString *)file {
    if (!file || file.length == 0) { [self notifyCueEnd:NO]; return; }
    [self stopCueInternal];
    // 找 bundle 内 Pandora apps 下的 static/audio/<file>
    NSString *name = [file lastPathComponent];
    NSString *found = nil;
    NSBundle *mainBundle = [NSBundle mainBundle];
    NSString *wwwRoot = [mainBundle.bundlePath stringByAppendingPathComponent:@"Pandora/apps"];
    NSArray<NSString *> *apps = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:wwwRoot error:nil] ?: @[];
    for (NSString *app in apps) {
        NSString *p = [[[wwwRoot stringByAppendingPathComponent:app] stringByAppendingPathComponent:@"www/static/audio"] stringByAppendingPathComponent:name];
        if ([[NSFileManager defaultManager] fileExistsAtPath:p]) { found = p; break; }
    }
    if (!found) {
        // 兜底：直接在 bundle 根 static/audio 找
        NSString *p = [[mainBundle.bundlePath stringByAppendingPathComponent:@"static/audio"] stringByAppendingPathComponent:name];
        if ([[NSFileManager defaultManager] fileExistsAtPath:p]) found = p;
    }
    if (!found) {
        NSLog(@"%@ playCue 未找到文件: %@", kTag, file);
        [self notifyCueEnd:NO];
        return;
    }
    NSError *err = nil;
    _cuePlayer = [[AVAudioPlayer alloc] initWithContentsOfURL:[NSURL fileURLWithPath:found] error:&err];
    if (!_cuePlayer) {
        NSLog(@"%@ playCue 创建播放器失败: %@", kTag, err.localizedDescription);
        [self notifyCueEnd:NO];
        return;
    }
    _cuePlayer.delegate = self;
    // 关键：不再 setCategory / setActive——复用采集的 PlayAndRecord 会话直接播放，
    // 避免 DCloud InnerAudioContext 切换 category 打断 KWS 采集。
    // 但必须切外放：PlayAndRecord 默认输出是听筒（receiver），首启「网关启动中」这类
    // 在任何 TTS 之前的提示音会从听筒出，音量比后面走外放的提示音小一截（真机现象）。
    // 与 TTS 首帧的 overrideOutputAudioPort 保持一致，只改输出口、不碰 category。
    [[AVAudioSession sharedInstance] overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:nil];
    [_cuePlayer prepareToPlay];
    BOOL ok = [_cuePlayer play];
    NSLog(@"%@ playCue %@ ok=%d", kTag, name, ok);
    if (!ok) [self notifyCueEnd:NO];
}

UNI_EXPORT_METHOD(@selector(stopCue))
- (void)stopCue {
    [self stopCueInternal];
}

- (void)stopCueInternal {
    if (_cuePlayer) {
        _cuePlayer.delegate = nil;
        if (_cuePlayer.isPlaying) [_cuePlayer stop];
        _cuePlayer = nil;
    }
}

- (void)notifyCueEnd:(BOOL)completed {
    UniModuleKeepAliveCallback cb = _cueEndCb;
    if (cb) @try { cb(@(completed), YES); } @catch (NSException *e) {}
}

- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)flag {
    if (player == _cuePlayer) {
        _cuePlayer = nil;
        [self notifyCueEnd:flag];
    }
}

- (void)audioPlayerDecodeErrorDidOccur:(AVAudioPlayer *)player error:(NSError *)error {
    if (player == _cuePlayer) {
        _cuePlayer = nil;
        [self notifyCueEnd:NO];
    }
}

#pragma mark - 采集

- (void)startCapture {
    // 即便此刻 engine 还在跑，也要把"意图"置真：熄屏/中断停摆后靠它触发自愈。
    _wantRunning = YES;
    if (_running && _engine.isRunning) {
        NSLog(@"%@ startCapture: already running, mark want=YES", kTag);
        return;
    }
    // 点击开始时按需请求麦克风权限；授权成功后（含异步弹框回调）才真正启动采集。
    __weak typeof(self) weakSelf = self;
    [self requestMicPermissionWithCompletion:^(BOOL granted) {
        if (!granted) {
            // 权限没拿到就不留"想要采集"的假意图，否则看门狗会 2s 一次空重启刷屏
            __strong typeof(weakSelf) strongSelf = weakSelf;
            strongSelf->_wantRunning = NO;
            return;
        }
        [weakSelf startCaptureInternal];
    }];
}

/// 权限已就绪，真正启动 AVAudioEngine 采集（从原 startCapture 主体拆出）。
- (void)startCaptureInternal {
    if (_running) return;
    AVAudioSession *session = AVAudioSession.sharedInstance;
    // 注意：CategoryRecord + ModeVoiceChat 在部分 iOS 版本是非法组合，setCategory 会直接失败。
    // 语音助手用 PlayAndRecord + VoiceChat（标准语音通话组合），并允许蓝牙/默认外放，
    // 也避免与保活静音的 playback 类别冲突。
    NSError *catErr = nil;
    // mixWithOthers：允许与提示音/TTS/保活静音的播放会话共存，避免「别的会话开始播放」
    // 触发 SomeOtherNonAmbientSessionIsPlayingDidChange 中断采集（真机实测采集 1.6s 后停）。
    // 采集以录音为主，去掉 defaultToSpeaker（与 mixWithOthers 语义冲突），保留蓝牙。
    BOOL catOk = [session setCategory:AVAudioSessionCategoryPlayAndRecord
                                 mode:AVAudioSessionModeVoiceChat
                              options:AVAudioSessionCategoryOptionMixWithOthers | AVAudioSessionCategoryOptionAllowBluetooth
                                error:&catErr];
    if (!catOk) {
        // 退而求其次：某些 iOS 版本 PlayAndRecord+VoiceChat 不接受 mixWithOthers，去掉再试
        catErr = nil;
        catOk = [session setCategory:AVAudioSessionCategoryPlayAndRecord
                                 mode:AVAudioSessionModeVoiceChat
                              options:AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetooth
                                error:&catErr];
    }
    if (!catOk) {
        [self emitError:[NSString stringWithFormat:@"setCategory失败:%@", catErr.localizedDescription ?: @"未知"]];
        return;
    }
    [session setPreferredSampleRate:kSampleRate error:nil];
    NSError *activeErr = nil;
    if (![session setActive:YES error:&activeErr]) {
        [self emitError:[NSString stringWithFormat:@"setActive失败:%@", activeErr.localizedDescription ?: @"未知"]];
        return;
    }

    _engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = _engine.inputNode;
    // 关键修复：不再硬编码 16k 格式 installTap——VoiceChat 模式下 inputNode 实际硬件格式
    // （通常 48k/interleaved）与硬编码的 16k/mono 不匹配，installTapOnBus 的 SetOutputFormat
    // 会抛 NSException 直接崩 App（真机 SIGABRT 铁证）。改用 inputNode 的当前实际格式，
    // 在 onPcmBuffer 里重采样到 16k/mono 再喂 ASR/KWS。
    [_engine prepare];
    AVAudioFormat *hwFormat = [input outputFormatForBus:0];
    if (!hwFormat) {
        [self emitError:@"inputNode 格式获取失败"];
        [session setActive:NO error:nil];
        _engine = nil;
        return;
    }
    _inputSampleRate = hwFormat.sampleRate > 0 ? hwFormat.sampleRate : kSampleRate;
    AVAudioFormat *tapFormat = hwFormat; // 用硬件实际格式，避免格式不匹配崩溃
    __weak typeof(self) weakSelf = self;
    // 【2026-11-23 修自愈重启崩溃】installTapOnBus 在某些状态（自愈重建 engine、旧 tap 残留、
    // 硬件格式运行时变化）会抛 NSException（AVAE_RaiseException/CreateRecordingTap）直接 SIGABRT。
    // 崩溃栈铁证：restartCaptureInternal→startCaptureInternal→installTapOnBus 崩。用 @try/@catch
    // 兜住：这次自愈失败就不置 _running，看门狗下次再试，绝不崩 App。
    @try {
        [input installTapOnBus:0
                    bufferSize:kFrameSamples
                        format:tapFormat
                         block:^(AVAudioPCMBuffer * _Nonnull buffer, AVAudioTime * _Nonnull when) {
            [weakSelf onPcmBuffer:buffer];
        }];
    } @catch (NSException *e) {
        NSLog(@"%@ installTap 异常(自愈本次失败，下次重试): %@", kTag, e.reason);
        _engine = nil;
        [session setActive:NO error:nil];
        return;
    }

    NSError *err = nil;
    if (![_engine startAndReturnError:&err]) {
        [self emitError:[NSString stringWithFormat:@"AVAudioEngine start failed: %@", err.localizedDescription]];
        [input removeTapOnBus:0];
        _engine = nil;
        return;
    }
    _running = YES;
    _lastFrameAt = CFAbsoluteTimeGetCurrent();
    NSLog(@"%@ capture started: %ldHz/%ldch/%ldbit frame=%ldB actualRate=%.0f want=%d",
          kTag, (long)kSampleRate, (long)kChannels, (long)kBits, (long)kFrameBytes,
          session.sampleRate, _wantRunning);
}

- (void)onPcmBuffer:(AVAudioPCMBuffer *)buffer {
    if (!_running) return;
    _lastFrameAt = CFAbsoluteTimeGetCurrent();
    const float *ch = buffer.floatChannelData ? buffer.floatChannelData[0] : NULL;
    if (!ch) return;
    NSUInteger n = buffer.frameLength;
    double inSR = _inputSampleRate > 0 ? _inputSampleRate : kSampleRate;

    // 硬件格式重采样到 16k/mono（线性插值），再转 int16 PCM。
    // 输出样本数 = 输入帧数 * 16000 / 实际采样率。
    NSUInteger outCount = (NSUInteger)llround((double)n * kSampleRate / inSR);
    NSMutableData *pcm = [NSMutableData dataWithCapacity:outCount * 2];   // 增益后，给 ASR/上行
    NSMutableData *kwsPcm = [NSMutableData dataWithCapacity:outCount * 2]; // 原始，给 KWS
    double rawSum = 0; // 原始帧能量（中断前 duck 检测人声开口用）
    for (NSUInteger o = 0; o < outCount; o++) {
        double srcPos = (double)o * inSR / kSampleRate;      // 对应输入样本位置（浮点）
        NSUInteger i0 = (NSUInteger)srcPos;
        NSUInteger i1 = i0 + 1 < n ? i0 + 1 : i0;
        float frac = (float)(srcPos - (double)i0);
        float raw = ch[i0] * (1.0f - frac) + ch[i1] * frac;  // 线性插值后的原始幅度
        rawSum += raw * raw; // 仅一次乘加，采集线程每帧512样本，开销可忽略
        // KWS 用温和放大(kKwsGain=6x)+钳位0.95 的帧：既达到模型可用音量(原始太小)，
        // 又避免 12x 满幅削波成方波导致声学特征失真（唤醒词难命中、要喊好几遍）。
        float kws = raw * kKwsGain;
        if (kws > 0.95f) kws = 0.95f; else if (kws < -0.95f) kws = -0.95f;
        int16_t kv = (int16_t)(kws * 32767);
        [kwsPcm appendBytes:&kv length:2];
        float s = raw * kInputGain;                           // 放大到正常近场幅度（仅给 ASR/上行）
        if (s > 1) s = 1; else if (s < -1) s = -1;
        int16_t v = (int16_t)(s * 32767);
        [pcm appendBytes:&v length:2];
    }
    // KWS 用原始帧（常驻唤醒）；KwsEngine 内部后台推理，不在此线程阻塞。
    if (_kwsEngine) {
        [_kwsEngine feedPCM:(const int16_t *)kwsPcm.bytes count:outCount];
    }
    // 【两端统一·中断前 duck】播报期检测到人声开口(raw rms>阈值)压低 TTS(AudioQueue) 给 KWS 让路。
    // 只在 _duckEnabled && _playRunning 时算，开销极小（一次 sqrt + 一次比较）。
    if (_duckEnabled && _playRunning && outCount > 0) {
        double rms = sqrt(rawSum / outCount);
        NSTimeInterval now = CFAbsoluteTimeGetCurrent();
        if (rms > 0.02) _lastVoiceMs = now;
        BOOL shouldDuck = (now - _lastVoiceMs) < 0.8;
        if (shouldDuck != _localDucked) {
            _localDucked = shouldDuck;
            if (_ttsQueue) {
                AudioQueueSetParameter(_ttsQueue, kAudioQueueParam_Volume, shouldDuck ? _duckVolume : _basePlaybackVolume);
            }
            NSLog(@"%@ LOCAL-DUCK %@ rms=%.4f", kTag, shouldDuck ? @"on" : @"off", rms);
        }
    }
    [_carry appendData:pcm];

    NSUInteger total = _carry.length;
    NSUInteger off = 0;
    while (total - off >= kFrameBytes) {
        NSData *frame = [_carry subdataWithRange:NSMakeRange(off, kFrameBytes)];
        off += kFrameBytes;
        _frameCount++;
        // 原生直连上传（绕开 weex 桥，性能最优且 iOS 桥传帧本来就是坏的）
        // 助手出声期上行静音：TTS 播报(_playRunning) 和提示音(_cuePlayer，如"我在"/"稍等一下")
        // 从扬声器外放会被麦克风收回，增益放大后回声强到把助手自己的话识别成用户输入
        // → ASR 触发新一轮 → 再播报 → 再收回，自激死循环、界面卡在播报。
        // 出声期一律发全 0 帧杜绝回声进 ASR；KWS 仍喂原始帧（短唤醒词命中用于打断，不受影响）。
        // 待唤醒态(_standbyMuted)上行全静音：唤醒前不调 ASR、不联网（端侧 KWS 常驻听），
        // 网关即使残留 session 也收不到真人声、不会触发 ASR 识别。KWS 仍喂原始帧，唤醒照常。
        // 【2026-11-23 回退定稿】播报期恢复静音上行——曾尝试发真实帧让插话完整，
        // 但 iOS 无硬件 AEC，软件 AEC 消不干净 TTS 回声 → 播报内容被识别成用户输入 → 自激。
        // 两难不可兼得，选不自激：待唤醒/提示音/TTS 播报期都不上行，插话靠 KWS 喊「小熊小熊」打断。
        // 【2026-11-23 回退媒体播放静音】媒体播放(音乐/新闻 InnerAudioContext)期恢复上行真实帧：
        // 静音上行会让网关检测不到人声(frameRms>0.02)→ duck 不触发→ 无法边播边插话（用户体感
        // "播放时不能说话"）。Android 正是上行真实帧+硬件AEC消回声→duck→音量变小→插话。
        // iOS 无硬件AEC，回声风险由网关软件AEC + 能量判据(lastRms<0.004)兜底。
        // 【2026-11-23 最终定稿·iOS 接受不能普通插话】iOS 无硬件 AEC，播报期上行真实帧
        // → TTS 回声(rms 0.045)混进 ASR → duck 虽触发(音量变小)但识别的是回声、不准。
        // 用户拍板：不能可靠插话就别 duck（音量别变小）。故 TTS 播报期恢复静音上行，
        // 网关收不到回声、不误触发 duck、播报音量稳定。插话只靠端侧 KWS 喊「小熊小熊」
        // 打断（走原生原始帧、不受上行静音影响）。这与 Android 不同——Android 有硬件 AEC
        // 才能边播边插话，iOS 架构上做不到，接受此限制。
        // muteUplink 判据：
        //  - _standbyMuted = 前端统一门控 isAsrMuted() 的结果（待唤醒/思考/说/播报期静音，规则在前端一处）
        //  - _playRunning / _cuePlayer.isPlaying / _soundTailMuteUntil = 原生瞬时物理状态兜底
        //    （TTS 首帧同步延迟、提示音、播报尾音——前端 phase 无法精确表达的几毫秒~2秒窗口）
        BOOL muteUplink = _playRunning || (_cuePlayer && _cuePlayer.isPlaying) || _standbyMuted
                          || (CFAbsoluteTimeGetCurrent() < _soundTailMuteUntil);
        if (!muteUplink) {
            [_pcmUploader upload:frame]; // 只有空闲对话期上传真实帧
        }
        // KWS 仍喂原始帧（上面已喂），唤醒/打断不受静音影响。
        // 只有直连未建立时才走 weex base64 回调兜底；已连接时必须停掉，避免两份音频喂 ASR。
        if (_pcmFrameCb && !_pcmUploader.isConnected && !muteUplink) {
            @try {
                NSString *b64 = [frame base64EncodedStringWithOptions:0];
                _pcmFrameCb(b64, YES);
            } @catch (NSException *e) {
                // JS 已解绑等，忽略继续采集
            }
        }
    }
    if (off > 0) {
        [_carry replaceBytesInRange:NSMakeRange(0, off) withBytes:NULL length:0];
    }
    // 播空检测不在这里做：已改为 startTtsIdleTimer 独立定时器驱动。
    // 旧实现在此调用 checkTtsIdle，依赖 tap 持续回调；tap 一旦停摆就永远检测不到播空
    // → playback_done 不发 → 界面卡「正在播报」（详见 startTtsIdleTimer 注释）。
}

- (void)stopCapture {
    // 先清意图：之后即便收到中断/配置变化通知也不再自愈重启
    _wantRunning = NO;
    if (!_running) return;
    _running = NO;
    if (_engine) {
        [_engine.inputNode removeTapOnBus:0];
        [_engine stop];
        _engine = nil;
    }
    [_carry setLength:0];
    _frameCount = 0;
    AVAudioSession *session = AVAudioSession.sharedInstance;
    [session setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:nil];
    NSLog(@"%@ capture stopped", kTag);
}

#pragma mark - 采集自愈（熄屏 / 音频中断 / 引擎配置变化 / 回前台）

/**
 * 常驻 2s 巡检（运行在 native 串行队列，JS 被后台冻结也照跑）。
 * 只判断"用户还想采集但引擎已停/超过 2s 没出帧"，正常态不做任何动作。
 */
- (void)startCaptureWatchdog {
    @synchronized (self) {
        if (_captureWatchdog) return;
        if (!_captureEventQueue) _captureEventQueue = dispatch_queue_create("com.xiaoxiong.capture.event", DISPATCH_QUEUE_SERIAL);
        dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _captureEventQueue);
        if (!timer) return;
        dispatch_source_set_timer(timer,
                                  dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.0 * NSEC_PER_SEC)),
                                  (uint64_t)(2.0 * NSEC_PER_SEC),
                                  (uint64_t)(0.5 * NSEC_PER_SEC));
        __weak typeof(self) weakSelf = self;
        dispatch_source_set_event_handler(timer, ^{
            [weakSelf scheduleCaptureRestart:@"watchdog" force:NO];
        });
        _captureWatchdog = timer;
        dispatch_resume(timer);
    }
}

- (void)stopCaptureWatchdog {
    @synchronized (self) {
        if (!_captureWatchdog) return;
        dispatch_source_cancel(_captureWatchdog);
        _captureWatchdog = nil;
    }
}

- (void)handleAudioInterruption:(NSNotification *)note {
    NSNumber *type = note.userInfo[AVAudioSessionInterruptionTypeKey];
    if (!type) return;
    if (type.unsignedIntegerValue == AVAudioSessionInterruptionTypeBegan) {
        NSLog(@"%@ 音频中断开始 want=%d running=%d", kTag, _wantRunning, _running);
        return;
    }
    // 中断结束（来电/其它 App 抢占/熄屏保活切换）：系统是否建议 resume 都不等，
    // 只要用户仍想采集就重建，避免"系统没给 ShouldResume 标志 → 采集永久停"。
    NSLog(@"%@ 音频中断结束，准备恢复采集", kTag);
    [self scheduleCaptureRestart:@"interruption-ended" force:NO];
}

- (void)handleMediaServicesReset:(NSNotification *)note {
    NSLog(@"%@ 媒体服务重置，准备恢复采集", kTag);
    [self scheduleCaptureRestart:@"media-services-reset" force:YES];
}

- (void)handleEngineConfigChange:(NSNotification *)note {
    NSLog(@"%@ 引擎配置变化，检查采集是否停摆", kTag);
    // 不强制：setCategory/installTap 自身也会触发此通知，健康时不折腾。
    [self scheduleCaptureRestart:@"engine-config-change" force:NO];
}

- (void)handleAppDidBecomeActive:(NSNotification *)note {
    NSLog(@"%@ App 回前台，强制自检采集", kTag);
    // 回前台强制重建一次：熄屏期间可能出现 engine.isRunning=YES 但 tap 早已停的僵尸态；
    // 且 sceneWillEnterForeground 会停掉保活静音，会话状态正好需要复位。
    [self scheduleCaptureRestart:@"app-did-become-active" force:YES];
}

/// 延迟一点再重启：等系统完成会话/路由切换，避免立刻重建又被同一次切换掐掉。
- (void)scheduleCaptureRestart:(NSString *)reason force:(BOOL)force {
    if (!_wantRunning) return;
    NSUInteger gen;
    @synchronized (self) { gen = ++_restartGeneration; }
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)), _captureEventQueue, ^{
        [weakSelf performCaptureRestartWithGeneration:gen reason:reason force:force];
    });
}

- (void)performCaptureRestartWithGeneration:(NSUInteger)gen reason:(NSString *)reason force:(BOOL)force {
    @synchronized (self) { if (gen != _restartGeneration) return; }
    if (!_wantRunning) return;
    if (!force && _running && _engine.isRunning &&
        (CFAbsoluteTimeGetCurrent() - _lastFrameAt) < 2.0) {
        return; // 引擎健康，不重复拆建
    }
    [self restartCaptureInternal:reason];
}

/// 彻底拆掉旧引擎并重装 tap（权限已就绪，不再走弹框路径）。
- (void)restartCaptureInternal:(NSString *)reason {
    NSLog(@"%@ RESTART-CAPTURE reason=%@ running=%d lastFrameAge=%.1fs",
          kTag, reason, _running, CFAbsoluteTimeGetCurrent() - _lastFrameAt);
    _running = NO;
    AVAudioEngine *old = _engine;
    _engine = nil;
    if (old) {
        @try { [old.inputNode removeTapOnBus:0]; }
        @catch (NSException *e) { NSLog(@"%@ removeTap 异常(忽略): %@", kTag, e.reason); }
        if (old.isRunning) [old stop];
    }
    [_carry setLength:0];
    // 不调 setActive:NO：GatewayLauncher 的静音保活与采集共用同一 audio session，
    // 关掉会连带掐掉后台保活；startCaptureInternal 会按采集口径重设 category 并 setActive:YES。
    [self startCaptureInternal];
}

#pragma mark - 原生 TTS 播放（AudioQueue，写 role=pcm 下发的 24k int16 PCM）

/// AudioQueue 填充回调：从 _ttsBuffer 拷数据；空则填静音。userdata 传 self。
static void ttsAudioQueueCallback(void *userData, AudioQueueRef queue, AudioQueueBufferRef buffer) {
    AppProductWakeModule *self = (__bridge AppProductWakeModule *)userData;
    NSUInteger want = buffer->mAudioDataBytesCapacity;
    NSUInteger n = [self fillTtsBuffer:buffer->mAudioData max:want];
    if (n < want) {
        memset((uint8_t *)buffer->mAudioData + n, 0, want - n); // 静音填充
    }
    buffer->mAudioDataByteSize = (UInt32)want;
    AudioQueueEnqueueBuffer(queue, buffer, 0, NULL);
}

/// 供 C 回调调用：从缓冲拷贝最多 max 字节到 dst，返回实际拷贝数
- (NSUInteger)fillTtsBuffer:(void *)dst max:(NSUInteger)max {
    [_ttsLock lock];
    NSUInteger avail = _ttsBuffer.length;
    NSUInteger n = MIN(max, avail);
    if (n > 0) {
        memcpy(dst, _ttsBuffer.bytes, n);
        [_ttsBuffer replaceBytesInRange:NSMakeRange(0, n) withBytes:NULL length:0];
        _ttsLastDataAt = CFAbsoluteTimeGetCurrent();
    }
    [_ttsLock unlock];
    return n;
}

/// 确保 TTS AudioQueue 已启动（复用采集的 PlayAndRecord 会话，不重设 category）
- (void)ensureTtsQueue {
    [_ttsLock lock];
    BOOL exists = (_ttsQueue != nil);
    [_ttsLock unlock];
    if (exists) return;
    AVAudioSession *session = [AVAudioSession sharedInstance];
    // 首帧播放切外放保证 audible（"声音小"根因之一）；不重设 category（会杀采集）
    [session overrideOutputAudioPort:AVAudioSessionPortOverrideSpeaker error:nil];

    AudioStreamBasicDescription asbd;
    memset(&asbd, 0, sizeof(asbd));
    asbd.mSampleRate = 24000;
    asbd.mFormatID = kAudioFormatLinearPCM;
    asbd.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked;
    asbd.mChannelsPerFrame = 1;
    asbd.mBitsPerChannel = 16;
    asbd.mFramesPerPacket = 1;
    asbd.mBytesPerFrame = 2;
    asbd.mBytesPerPacket = 2;

    OSStatus st = AudioQueueNewOutput(&asbd, ttsAudioQueueCallback, (__bridge void *)self,
                                      NULL, NULL, 0, &_ttsQueue);
    if (st != noErr) { NSLog(@"%@ AudioQueueNewOutput failed %d", kTag, (int)st); return; }
    // 3 个 buffer 循环，每个 100ms @24k = 4800 字节
    for (int i = 0; i < 3; i++) {
        AudioQueueBufferRef buf = NULL;
        AudioQueueAllocateBuffer(_ttsQueue, 4800, &buf);
        if (buf) ttsAudioQueueCallback((__bridge void *)self, _ttsQueue, buf);
    }
    AudioQueueStart(_ttsQueue, NULL);
    _playRunning = YES;
    NSLog(@"%@ TTS AudioQueue started", kTag);
    // 播空检测由独立定时器驱动，不再依赖采集回调（见 startTtsIdleTimer 注释）
    [self startTtsIdleTimer];
}

/**
 * 启动播空检测定时器（100ms 轮询）。
 *
 * 为什么不能用采集回调顺带检查（旧实现）：那要求 AVAudioEngine 的 tap 一直在跑。真机上
 * 首帧播放会 overrideOutputAudioPort:Speaker 切路由，路由变化可能让引擎 tap 停摆；播报期
 * 上行被静音、JS 线程被 TTS 占满时也可能不再回调——于是 checkTtsIdle 永不执行 →
 * session.playback_done 不发 → 网关 tts.idle 不来 → 界面永久卡「正在播报」，只能等前端
 * 60s SPEECH_WATCHDOG 兜底（真机现象：播完要等很久状态才变）。Android 一直用独立
 * idle polling 线程，所以只有 iOS 复现。这里对齐 Android：定时器不依赖任何外部回调。
 */
- (void)startTtsIdleTimer {
    // 注意：这里绝不能用 dispatch_async + block 强捕获 self。
    // -dealloc → stopTtsQueueInternal → stopTtsIdleTimer 也会走到这里，若 block 捕获 self，
    // 会在对象已开始析构后再 retain 一次（复活），block 释放时 objc_release 到已释放内存 →
    // SIGSEGV。真机崩溃栈铁证：线程 com.xiaoxiong.tts.idle 的 __destroy_helper_block_e8_32s
    // → objc_release。App 端这个模块非单例、启动期会被创建/释放，所以一启动就崩。
    // 因此生命周期全同步做：dispatch_source_cancel 本身线程安全、不需要 block。
    @synchronized (self) {
        if (_ttsIdleTimer) return;
        if (!_ttsIdleQueue) _ttsIdleQueue = dispatch_queue_create("com.xiaoxiong.tts.idle", DISPATCH_QUEUE_SERIAL);
        dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _ttsIdleQueue);
        if (!timer) return;
        // 100ms 一次，允许 50ms 抖动（省电，不影响 600ms 判空精度）
        dispatch_source_set_timer(timer,
                                  dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)),
                                  (uint64_t)(0.1 * NSEC_PER_SEC),
                                  (uint64_t)(0.05 * NSEC_PER_SEC));
        // 只弱捕获：self 释放后 handler 变 no-op，不会复活也不会访问野指针
        __weak AppProductWakeModule *weakSelf = self;
        dispatch_source_set_event_handler(timer, ^{
            [weakSelf checkTtsIdle];
        });
        _ttsIdleTimer = timer;
        dispatch_resume(timer);
    }
}

/** 停播空检测定时器（同步取消；可从 dealloc / 定时器自身 handler 里调用）。 */
- (void)stopTtsIdleTimer {
    @synchronized (self) {
        if (!_ttsIdleTimer) return;
        dispatch_source_cancel(_ttsIdleTimer);
        _ttsIdleTimer = nil;
    }
}

/// 停止 TTS AudioQueue 并复位
- (void)stopTtsQueueInternal {
    [self stopTtsIdleTimer];
    // 先在同一把锁内把 _ttsQueue 置空、清缓冲，再停/释放队列：
    // 这样 checkTtsIdle（定时器队列）读到的状态与这里一致，不会在停播后又误判一次播空；
    // 且 AudioQueueStop/Dispose 不在锁内调用，避免与填充回调（要抢同一把锁）互等。
    AudioQueueRef q;
    [_ttsLock lock];
    q = _ttsQueue;
    _ttsQueue = nil;
    [_ttsBuffer setLength:0];
    _ttsHasData = NO;
    [_ttsLock unlock];
    if (q) {
        AudioQueueStop(q, true);
        AudioQueueDispose(q, true);
    }
    _playRunning = NO;
    // 【防播报余音自激】播空检测(缓冲空)早于扬声器真正播完：此处停队列后扬声器还在出声，
    // 若立即恢复上行，尾音被麦克风收回→识别成"第一条第一条"→自激。尾巴静音 2s 覆盖余音。
    _soundTailMuteUntil = CFAbsoluteTimeGetCurrent() + 2.0;
    NSLog(@"%@ TTS tail mute until +2.0s", kTag);
}

/// TTS 播空检测：环形缓冲连续空 ≥600ms 且有数据历史 → 播完。由 startTtsIdleTimer 每 100ms 驱动。
- (void)checkTtsIdle {
    // 状态字段跨线程读写（WS 线程写 _ttsQueue/_ttsHasData，本方法在定时器队列读），统一在锁内取快照
    [_ttsLock lock];
    BOOL active = (_ttsQueue != nil && _ttsHasData);
    NSUInteger avail = _ttsBuffer.length;
    NSTimeInterval lastAt = _ttsLastDataAt;
    [_ttsLock unlock];
    if (!active) return;
    if (avail == 0 && CFAbsoluteTimeGetCurrent() - lastAt >= 0.6) {
        NSLog(@"%@ TTS idle detected", kTag);
        // ① 原生 sendText 回执（可靠主路）
        [_pcmUploader sendText:@"{\"type\":\"session.playback_done\"}"];
        // ② 回调 JS（辅路）
        UniModuleKeepAliveCallback cb = _playbackIdleCb;
        if (cb) @try { cb(@YES, YES); } @catch (NSException *e) {}
        // ③ 自复位停队列（同时取消本定时器）
        [self stopTtsQueueInternal];
    }
}

// JS 导出：TTS 播放接口（让 isAppPlaybackSupported 探测为 true）
UNI_EXPORT_METHOD(@selector(startPlayback:))
- (void)startPlayback:(NSInteger)sampleRate {
    _playRunning = NO; // 等首帧再起队列
}

UNI_EXPORT_METHOD(@selector(playPcm:))
- (void)playPcm:(NSString *)b64 {
    if (!b64) return;
    // base64 解码（App 回调用 base64 标量字符串过桥可靠）
    NSData *pcm = [[NSData alloc] initWithBase64EncodedString:b64 options:0];
    [self onTtsFrame:pcm];
}

UNI_EXPORT_METHOD(@selector(stopPlayback))
- (void)stopPlayback {
    [self stopTtsQueueInternal];
}

UNI_EXPORT_METHOD(@selector(onPlaybackIdle:))
- (void)onPlaybackIdle:(UniModuleKeepAliveCallback)callback {
    if (callback) _playbackIdleCb = [callback copy];
}

UNI_EXPORT_METHOD(@selector(setPlaybackVolume:))
- (void)setPlaybackVolume:(NSInteger)percent {
    _basePlaybackVolume = MAX(0, MIN(1, percent / 100.0f));
    if (_ttsQueue && !_localDucked) {
        AudioQueueSetParameter(_ttsQueue, kAudioQueueParam_Volume, _basePlaybackVolume);
    }
}

/** 【2026-11-24 两端统一 duck】设置页 duck 配置（与 Android 同签名）。 */
UNI_EXPORT_METHOD(@selector(setDuckConfig:duckPercent:bargeIn:))
- (void)setDuckConfig:(BOOL)interruptDuck duckPercent:(NSInteger)duckPercent bargeIn:(BOOL)bargeIn {
    _duckEnabled = interruptDuck;
    _duckVolume = MAX(0, MIN(1, duckPercent / 100.0f));
    _bargeInEnabled = bargeIn;
    if (!interruptDuck && _localDucked) {
        _localDucked = NO;
        if (_ttsQueue) AudioQueueSetParameter(_ttsQueue, kAudioQueueParam_Volume, _basePlaybackVolume);
    }
    NSLog(@"%@ setDuckConfig interruptDuck=%d percent=%ld bargeIn=%d", kTag, interruptDuck, (long)duckPercent, bargeIn);
}

/** 【对照实验】硬件 AEC 开关。iOS 的 AEC 由 AVAudioSessionModeVoiceChat 提供，
 *  动态切 mode 需 setCategory 重设会话、有杀采集风险，故此处只记录状态不实际切换。
 *  iOS 采集 tap 拿的是 AEC 前原始帧（KWS 喂它不受影响），对照实验主战场在 Android。 */
UNI_EXPORT_METHOD(@selector(setAecUserEnabled:))
- (void)setAecUserEnabled:(BOOL)enabled {
    NSLog(@"%@ setAecUserEnabled=%d (iOS VPIO by VoiceChat mode, no dynamic switch)", kTag, enabled);
}

#pragma mark - 错误上报

- (void)emitError:(NSString *)msg {
    if (_pcmErrorCb) {
        @try {
            _pcmErrorCb(msg ?: @"native error", YES);
        } @catch (NSException *e) {
        }
    }
    NSLog(@"%@ emitError: %@", kTag, msg);
}

@end
