//
//  PcmUploader.h
//  iOS 原生 PCM 直连网关上报（对标 Android PcmUploader.java）
//
//  为什么需要：iOS DCloud weex 桥把原生采集帧 NSData 转成 [object NSData]，前端 toArrayBuffer
//  不认识 → 每帧丢弃 → 唤醒后说话网关 ASR 收不到、无法对话。绕开方案：原生用
//  NSURLSessionWebSocketTask 连网关「音频专用连接」(?role=pcm)，直接推 PCM，不经 JS 桥。
//  该连接只喂 session.handleBinary / 下发 TTS，不 bindTransport，不影响 JS 主连接事件收发。
//
//  role=pcm 是双向的：上行采集 PCM，下行 TTS 音频帧（经 TtsFrameListener 原生播放）。
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@protocol PcmUploaderTtsListener <NSObject>
/// 网关下发的 TTS 音频帧（24k int16 mono），原生直接播放，不经 JS
- (void)onTtsFrame:(NSData *)pcm;
@optional
/// 网关下发的文本控制帧（备用）
- (void)onTextFrame:(NSString *)text;
@end

@interface PcmUploader : NSObject

/// 单例
+ (instancetype)shared;

/// 配置 deviceId 并开启直连（JS configureDirectUpload 时调用）
- (void)configure:(NSString *)deviceId;

/// 采集循环每帧调用：推一帧 PCM 到网关（未连接时限频重连、静默丢弃）
- (void)upload:(NSData *)pcm;

/// 经直连发文本控制帧（如 {"type":"session.playback_done"}），可靠不经 weex
- (void)sendText:(NSString *)text;

/// 停止并关闭连接
- (void)stop;

/// 直连是否已建立（用于决定是否停 weex 回调防双份音频）
@property (nonatomic, readonly) BOOL isConnected;

/// TTS 下行帧监听（原生播放）
@property (nonatomic, weak, nullable) id<PcmUploaderTtsListener> ttsListener;

@end

NS_ASSUME_NONNULL_END
