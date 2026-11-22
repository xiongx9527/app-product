#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// 独立诊断：在 App 进程内起一个本地 WS server(8787) + NSURLSessionWebSocketTask 客户端，
/// 反复发文本帧并记录 sendMessage completion 延迟，验证 iOS 本地 WS 写出是否会卡几十秒。
@interface WSProbe : NSObject
- (void)start;
@end

NS_ASSUME_NONNULL_END
