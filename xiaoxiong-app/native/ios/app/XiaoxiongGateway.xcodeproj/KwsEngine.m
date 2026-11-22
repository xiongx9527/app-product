//
//  KwsEngine.m
//  app-product-wake iOS 端 sherpa-onnx 关键词唤醒引擎
//
//  C API 签名核实自 sherpa-onnx-v2.0.2 ios static xcframework 的 c-api.h：
//    SherpaOnnxCreateKeywordSpotter / CreateKeywordStream / OnlineStreamAcceptWaveform /
//    IsKeywordStreamReady / DecodeKeywordStream / GetKeywordResult / ResetKeywordStream /
//    DestroyOnlineStream / DestroyKeywordSpotter
//  KWS 复用通用 OnlineStream，无独立 feed 函数。
//

#import "KwsEngine.h"
#import <sherpa-onnx/c-api/c-api.h>

static NSString *const kTag = @"[KwsEngine]";
static const int32_t kSampleRate = 16000;
static const NSTimeInterval kWakeDebounce = 1.5; // 与 Android KWS_WAKE_DEBOUNCE_MS=1500 一致
static const NSUInteger kMaxPendingFrames = 16;  // 积压超过则丢最旧，防推理延迟累积

@interface KwsEngine () {
    const SherpaOnnxKeywordSpotter *_spotter;
    const SherpaOnnxOnlineStream *_stream;
    dispatch_queue_t _kwsQueue;
    NSMutableArray<NSData *> *_pendingFrames;
    BOOL _started;
    NSTimeInterval _lastHitAt;
}
@property (nonatomic, strong) NSBundle *bundle;
@end

@implementation KwsEngine

- (instancetype)initWithWakeWord:(NSString *)wakeWord bundle:(NSBundle *)bundle {
    self = [super init];
    if (self) {
        _wakeWord = [wakeWord copy];
        _bundle = bundle ?: [NSBundle mainBundle];
        _kwsQueue = dispatch_queue_create("com.xiaoxiong.kws.engine", DISPATCH_QUEUE_SERIAL);
        _pendingFrames = [NSMutableArray arrayWithCapacity:kMaxPendingFrames];
        _spotter = NULL;
        _stream = NULL;
        _started = NO;
        _lastHitAt = 0;
    }
    return self;
}

- (void)dealloc {
    // 同步释放，避免悬空指针
    [self stop];
}

#pragma mark - 模型加载

- (BOOL)ready {
    return _started;
}

- (BOOL)startWithError:(NSError **)error {
    if (_started) return YES;
    __block BOOL ok = NO;
    __block NSError *localErr = nil;
    dispatch_sync(_kwsQueue, ^{
        ok = [self p_startLockedWithError:&localErr];
    });
    if (!ok && error) *error = localErr;
    // 就绪回调（主线程）：模型加载成功才可常驻听唤醒词，前端据此显示"可喊词"
    if (ok) {
        void (^cb)(BOOL) = self.onReady;
        if (cb) dispatch_async(dispatch_get_main_queue(), ^{ cb(YES); });
    }
    return ok;
}

- (BOOL)p_startLockedWithError:(NSError **)error {
    // 2026-11-22 换用 zh-en-3M-2025 模型：离线验证旧模型只中1遍、新模型2遍全中
    NSString *modelDir = @"KwsResources/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20";
    NSString *root = [self.bundle.bundlePath stringByAppendingPathComponent:modelDir];
    // 新模型 epoch-13、chunk-16；decoder 官方无 int8 版，用 fp32 的 .onnx
    NSString *encoder = [root stringByAppendingPathComponent:@"encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"];
    NSString *decoder = [root stringByAppendingPathComponent:@"decoder-epoch-13-avg-2-chunk-16-left-64.onnx"];
    NSString *joiner = [root stringByAppendingPathComponent:@"joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx"];
    NSString *tokens = [root stringByAppendingPathComponent:@"tokens.txt"];
    NSString *keywords = [root stringByAppendingPathComponent:@"keywords.txt"];

    NSFileManager *fm = [NSFileManager defaultManager];
    for (NSString *p in @[encoder, decoder, joiner, tokens, keywords]) {
        if (![fm fileExistsAtPath:p]) {
            NSLog(@"%@ 模型文件缺失: %@", kTag, p);
            if (error) *error = [NSError errorWithDomain:@"KwsEngine" code:1
                              userInfo:@{NSLocalizedDescriptionKey: [NSString stringWithFormat:@"模型缺失:%@", p.lastPathComponent]}];
            return NO;
        }
    }
    NSLog(@"%@ 模型目录: %@", kTag, root);

    SherpaOnnxKeywordSpotterConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.feat_config.sample_rate = kSampleRate;
    cfg.feat_config.feature_dim = 80;
    cfg.model_config.transducer.encoder = encoder.UTF8String;
    cfg.model_config.transducer.decoder = decoder.UTF8String;
    cfg.model_config.transducer.joiner = joiner.UTF8String;
    cfg.model_config.tokens = tokens.UTF8String;
    cfg.model_config.num_threads = 1;   // C 侧无 Java 默认值，必须显式给
    cfg.model_config.provider = "cpu";
    cfg.model_config.model_type = "zipformer2";
    cfg.keywords_file = keywords.UTF8String;
    cfg.max_active_paths = 4;
    // score=2.0：真机录音离线 sweep 铁证——1.5 时两遍唤醒词只中第 2 遍，2.0 时两遍全中。
    // threshold 保持官方 0.25（0.02~0.25 对命中无影响，瓶颈在 score）。误唤醒由 rearm 去抖
    // + 只认「小熊小熊」兜底。
    cfg.keywords_score = 2.0f;
    cfg.keywords_threshold = 0.25f;

    _spotter = SherpaOnnxCreateKeywordSpotter(&cfg);
    if (!_spotter) {
        NSLog(@"%@ CreateKeywordSpotter 失败", kTag);
        if (error) *error = [NSError errorWithDomain:@"KwsEngine" code:2
                              userInfo:@{NSLocalizedDescriptionKey: @"KWS 引擎创建失败"}];
        return NO;
    }
    _stream = SherpaOnnxCreateKeywordStream(_spotter);
    if (!_stream) {
        SherpaOnnxDestroyKeywordSpotter(_spotter);
        _spotter = NULL;
        if (error) *error = [NSError errorWithDomain:@"KwsEngine" code:3
                              userInfo:@{NSLocalizedDescriptionKey: @"KWS Stream 创建失败"}];
        return NO;
    }
    _started = YES;
    NSLog(@"%@ 模型加载完成，KWS 已启动", kTag);
    return YES;
}

#pragma mark - 喂帧

- (void)feedPCM:(const int16_t *)samples count:(NSUInteger)count {
    if (!_started || count == 0) return;
    // 先在主调线程做 int16→float 转换（快），再把 NSData 丢进队列，避免持裸指针跨线程。
    NSMutableData *pcm = [NSMutableData dataWithLength:count * sizeof(float)];
    float *out = (float *)pcm.mutableBytes;
    for (NSUInteger i = 0; i < count; i++) {
        out[i] = (float)samples[i] / 32768.0f;
    }
    dispatch_async(_kwsQueue, ^{
        if (!self->_started || !self->_stream) return;
        // 不丢帧：KWS 必须拿到连续音频才能识别唤醒词。丢最旧会造成音频碎片、检不出词。
        // 只要 acceptWaveform 够快（仅喂特征），队列不会真积压。
        [self->_pendingFrames addObject:pcm];
        [self p_drainLocked];
    });
}

/// 必须在 _kwsQueue 内调用
- (void)p_drainLocked {
    while (_pendingFrames.count > 0) {
        NSData *frame = _pendingFrames.firstObject;
        [_pendingFrames removeObjectAtIndex:0];
        const float *samples = (const float *)frame.bytes;
        int32_t n = (int32_t)(frame.length / sizeof(float));
        SherpaOnnxOnlineStreamAcceptWaveform(_stream, kSampleRate, samples, n);

        while (SherpaOnnxIsKeywordStreamReady(_spotter, _stream)) {
            SherpaOnnxDecodeKeywordStream(_spotter, _stream);
            const SherpaOnnxKeywordResult *r = SherpaOnnxGetKeywordResult(_spotter, _stream);
            NSString *keyword = (r && r->keyword) ? [NSString stringWithUTF8String:r->keyword] : nil;
            if (r) SherpaOnnxDestroyKeywordResult(r);

            // 只在识别到有效 keyword 后 reset（与 Android 一致）。空结果绝不能 reset——
            // 否则 IsReady 一直 true、decode 一直空 → 死循环空转刷屏、永远检不出唤醒词。
            if (keyword.length > 0) {
                BOOL isWake = [keyword isEqualToString:self.wakeWord] || [keyword containsString:self.wakeWord];
                if (isWake) {
                    NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
                    if (now - _lastHitAt >= kWakeDebounce) {
                        _lastHitAt = now;
                        NSLog(@"%@ KWS HIT: %@", kTag, keyword);
                        void (^cb)(NSString *) = self.onWake;
                        if (cb) dispatch_async(dispatch_get_main_queue(), ^{ cb(keyword); });
                    }
                } else {
                    NSLog(@"%@ 其它词(忽略): %@", kTag, keyword);
                }
                SherpaOnnxResetKeywordStream(_spotter, _stream); // 仅命中有效词后复位
            }
        }
    }
}

#pragma mark - 停止

- (void)stop {
    if (!_started && !_spotter) return;
    dispatch_sync(_kwsQueue, ^{
        if (self->_stream) {
            SherpaOnnxDestroyOnlineStream(self->_stream);
            self->_stream = NULL;
        }
        if (self->_spotter) {
            SherpaOnnxDestroyKeywordSpotter(self->_spotter);
            self->_spotter = NULL;
        }
        [self->_pendingFrames removeAllObjects];
        self->_started = NO;
        NSLog(@"%@ 已停止并释放", kTag);
    });
}

@end
