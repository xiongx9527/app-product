//
//  KwsEngine.h
//  app-product-wake iOS 端 sherpa-onnx 关键词唤醒引擎
//
//  常驻监听「小熊小熊」，复用 PCM 采集帧（int16），唤醒前不调 ASR/不联网。
//  对应 Android WakeModule.java 的 KWS 部分（3.3M zipformer2 模型）。
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface KwsEngine : NSObject

/// 唤醒词（如「小熊小熊」）
@property (nonatomic, copy, readonly) NSString *wakeWord;
/// KWS 模型是否已加载完成、可常驻听唤醒词
@property (nonatomic, readonly) BOOL ready;

/// bundle 用于定位 KwsResources 里的模型文件（通常 Bundle.main）
- (instancetype)initWithWakeWord:(NSString *)wakeWord bundle:(NSBundle *)bundle;

/// 后台线程加载模型并启动 KWS 推理（1-3s，不阻塞调用线程）。失败返回 NO 并通过 onError 回调。
- (BOOL)startWithError:(NSError **)error;

/// 喂入一帧 PCM（int16、16k/mono）；内部转 float 并 dispatch 到 KWS 串行队列，不在调用线程推理。
- (void)feedPCM:(const int16_t *)samples count:(NSUInteger)count;

/// 停止并释放 sherpa 资源（队列内同步收敛）
- (void)stop;

/// 命中回调（在主线程触发）
@property (nonatomic, copy, nullable) void (^onWake)(NSString *word);
/// 就绪回调：模型加载完成后主线程触发（参数 YES=可唤醒）
@property (nonatomic, copy, nullable) void (^onReady)(BOOL ready);
/// 错误回调（在主线程触发）
@property (nonatomic, copy, nullable) void (^onError)(NSString *message);

@end

NS_ASSUME_NONNULL_END
