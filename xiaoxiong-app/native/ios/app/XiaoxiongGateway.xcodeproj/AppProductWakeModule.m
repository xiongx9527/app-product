//
//  AppProductWakeModule.m
//  app-product-wake 原生插件（iOS）—— PCM 采集，参照 Android WakeModule.java
//
//  音频链路：AVAudioEngine 麦克风 → installTap（16k/mono/float32）→ 转 int16 PCM
//            → 每 512 sample（32ms）= 1024 字节 → UniModuleKeepAliveCallback 回调 JS
//            → JS transport 送网关（JS 回调透传方案）
//

#import "AppProductWakeModule.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>

static NSString *const kTag = @"[app-product-wake]";

/** 上行契约：16k / 16bit / 单声道 / 32ms。 */
static const NSInteger kSampleRate = 16000;
static const NSInteger kChannels = 1;
static const NSInteger kBits = 16;
static const NSInteger kFrameMs = 32;
/** 每帧采样数 = 16000 * 0.032 = 512；每帧字节 = 512 * 2 = 1024。 */
static const NSInteger kFrameSamples = 512;
static const NSInteger kFrameBytes = 1024;

@interface AppProductWakeModule () {
    AVAudioEngine *_engine;
    BOOL _running;
    NSString *_deviceId;
    UniModuleKeepAliveCallback _pcmFrameCb;
    UniModuleKeepAliveCallback _pcmErrorCb;
    NSMutableData *_carry;      // 不足一帧的残留字节
    NSInteger _frameCount;
}
@end

@implementation AppProductWakeModule

- (instancetype)init {
    self = [super init];
    if (self) {
        _carry = [NSMutableData data];
        _running = NO;
        _frameCount = 0;
    }
    return self;
}

#pragma mark - 权限

- (BOOL)checkMicPermission {
    AVAuthorizationStatus st = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (st == AVAuthorizationStatusAuthorized) return YES;
    [self emitError:st == AVAuthorizationStatusDenied ? @"NEED_PERMISSION" : @"MIC_NOT_DETERMINED"];
    return NO;
}

#pragma mark - JS 导出方法

// DCloud 宏 UNI_EXPORT_METHOD(sel) 需与方法实现分开写：宏参数只放 selector（带冒号），
// 用于向引擎登记可调用方法名；方法体单独实现。

/** JS 把 deviceId 传入。JS 回调透传模式下仅记录，不原生直连。 */
UNI_EXPORT_METHOD(@selector(configureDirectUpload:))
- (void)configureDirectUpload:(NSString *)deviceId {
    _deviceId = deviceId ?: @"";
    NSLog(@"%@ configureDirectUpload deviceIdLen=%lu", kTag, (unsigned long)_deviceId.length);
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

#pragma mark - 采集

- (void)startCapture {
    if (_running) {
        NSLog(@"%@ startCapture ignored: already running", kTag);
        return;
    }
    if (![self checkMicPermission]) return;

    AVAudioSession *session = AVAudioSession.sharedInstance;
    if (![session setCategory:AVAudioSessionCategoryRecord
                         mode:AVAudioSessionModeVoiceChat
                      options:0 error:nil]) {
        [self emitError:@"AVAudioSession setCategory failed"];
        return;
    }
    [session setPreferredSampleRate:kSampleRate error:nil];
    if (![session setActive:YES error:nil]) {
        [self emitError:@"AVAudioSession setActive failed"];
        return;
    }

    _engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode *input = _engine.inputNode;
    // 16k/mono tap 格式，系统自动从硬件采样率（通常 48k）重采样。
    AVAudioFormat *tapFormat = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:kSampleRate channels:kChannels];
    __weak typeof(self) weakSelf = self;
    [input installTapOnBus:0
                bufferSize:kFrameSamples
                    format:tapFormat
                     block:^(AVAudioPCMBuffer * _Nonnull buffer, AVAudioTime * _Nonnull when) {
        [weakSelf onPcmBuffer:buffer];
    }];

    NSError *err = nil;
    if (![_engine startAndReturnError:&err]) {
        [self emitError:[NSString stringWithFormat:@"AVAudioEngine start failed: %@", err.localizedDescription]];
        [input removeTapOnBus:0];
        _engine = nil;
        return;
    }
    _running = YES;
    NSLog(@"%@ capture started: %ldHz/%ldch/%ldbit frame=%ldB actualRate=%.0f",
          kTag, (long)kSampleRate, (long)kChannels, (long)kBits, (long)kFrameBytes,
          session.sampleRate);
}

- (void)onPcmBuffer:(AVAudioPCMBuffer *)buffer {
    if (!_running) return;
    const float *ch = buffer.floatChannelData ? buffer.floatChannelData[0] : NULL;
    if (!ch) return;
    NSUInteger n = buffer.frameLength;

    // float32 [-1,1] → int16 PCM（小端），边转边攒进 carry，够一帧就回调。
    NSMutableData *pcm = [NSMutableData dataWithCapacity:n * 2];
    for (NSUInteger i = 0; i < n; i++) {
        float s = ch[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        int16_t v = (int16_t)(s * 32767);
        [pcm appendBytes:&v length:2];
    }
    [_carry appendData:pcm];

    NSUInteger total = _carry.length;
    NSUInteger off = 0;
    while (total - off >= kFrameBytes) {
        NSData *frame = [_carry subdataWithRange:NSMakeRange(off, kFrameBytes)];
        off += kFrameBytes;
        _frameCount++;
        if (_pcmFrameCb) {
            @try {
                _pcmFrameCb(frame, YES); // keepAlive：每帧都回调，对标 Android invokeAndKeepAlive
            } @catch (NSException *e) {
                // JS 已解绑等，忽略继续采集
            }
        }
        if (_frameCount % 50 == 0) {
            NSLog(@"%@ pcm frames=%ld (%ldms)", kTag, (long)_frameCount, (long)(_frameCount * kFrameMs));
        }
    }
    if (off > 0) {
        [_carry replaceBytesInRange:NSMakeRange(0, off) withBytes:NULL length:0];
    }
}

- (void)stopCapture {
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
