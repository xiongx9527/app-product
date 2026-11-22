//
//  PcmUploader.m
//  iOS 原生 PCM 直连网关（对标 Android PcmUploader.java）
//

#import "PcmUploader.h"
#import <Foundation/Foundation.h>

static NSString *const kTag = @"[PcmUploader]";
static const NSTimeInterval kReconnectInterval = 1.0; // 限频重连，采集线程每帧都调 upload

@interface PcmUploader () <NSURLSessionWebSocketDelegate> {
    NSURLSession *_session;
    NSURLSessionWebSocketTask *_task;
    NSString *_deviceId;
    BOOL _enabled;
    NSTimeInterval _lastConnectAttempt;
    BOOL _connected;
    dispatch_queue_t _queue; // 串行队列保护上述状态
    // 【关键日志·长期保留】断连期间暂存的文本回执（播空回执绝不能丢）。
    // 真机铁证：checkTtsIdle 16:35:14 调 sendText，网关 16:38:34(晚200s)才收到；
    // 旧实现在 _connected==NO 时静默丢弃且无任何日志，这段完全不可观测。禁止定位后删除。
    NSMutableArray<NSData *> *_pendingTexts;
}
@end

@implementation PcmUploader

+ (instancetype)shared {
    static PcmUploader *inst = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ inst = [[PcmUploader alloc] init]; });
    return inst;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _queue = dispatch_queue_create("com.xiaoxiong.pcm.uploader", DISPATCH_QUEUE_SERIAL);
        NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
        // 同设备 127.0.0.1 连接，不设 ping（Android 铁证：ping 每 10s 断连致 TTS 帧丢失）
        _session = [NSURLSession sessionWithConfiguration:cfg delegate:self delegateQueue:nil];
        _enabled = NO;
        _connected = NO;
        _lastConnectAttempt = 0;
        _pendingTexts = [NSMutableArray array];
    }
    return self;
}

- (BOOL)isConnected {
    __block BOOL c = NO;
    dispatch_sync(_queue, ^{ c = _connected; });
    return c;
}

#pragma mark - 端口

/// 读网关端口文件 Application Support/gateway/.gateway_port，失败回落 8787
- (NSString *)readPort {
    NSArray<NSString *> *paths = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES);
    if (paths.count == 0) return @"8787";
    NSString *portFile = [[paths[0] stringByAppendingPathComponent:@"gateway"] stringByAppendingPathComponent:@".gateway_port"];
    NSString *raw = [NSString stringWithContentsOfFile:portFile encoding:NSUTF8StringEncoding error:nil];
    NSString *port = raw ? [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] : nil;
    return (port && port.length > 0) ? port : @"8787";
}

#pragma mark - 连接

- (void)configure:(NSString *)deviceId {
    dispatch_async(_queue, ^{
        _deviceId = [deviceId copy];
        _enabled = YES;
        NSLog(@"%@ configure deviceId=%@", kTag, deviceId);
        [self connectLocked];
    });
}

- (void)connectLocked {
    if (!_enabled || _task != nil || !_deviceId) return;
    NSString *port = [self readPort];
    NSString *urlStr = [NSString stringWithFormat:@"ws://127.0.0.1:%@/ws?deviceId=%@&role=pcm", port, _deviceId];
    NSURL *url = [NSURL URLWithString:urlStr];
    if (!url) return;
    NSURLRequest *req = [NSURLRequest requestWithURL:url];
    _task = [_session webSocketTaskWithRequest:req];
    _connected = NO;
    [_task resume];
    [self receiveLocked]; // 启动接收循环
    NSLog(@"%@ connecting %@", kTag, urlStr);
}

/// 递归接收消息：binary→TTS 播放，text→控制帧
- (void)receiveLocked {
    __weak typeof(self) weakSelf = self;
    [_task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage * _Nullable message, NSError * _Nullable error) {
        __strong typeof(weakSelf) self = weakSelf;
        if (!self) return;
        if (error) {
            NSLog(@"%@ receive error: %@", kTag, error.localizedDescription);
            dispatch_async(self->_queue, ^{
                if (self->_task) { self->_task = nil; self->_connected = NO; }
            });
            return;
        }
        if (message.type == NSURLSessionWebSocketMessageTypeData) {
            NSData *data = message.data;
            id<PcmUploaderTtsListener> l = self.ttsListener;
            if (l && data) {
                dispatch_async(dispatch_get_main_queue(), ^{ [l onTtsFrame:data]; });
            }
        } else if (message.type == NSURLSessionWebSocketMessageTypeString) {
            NSString *text = message.string;
            id<PcmUploaderTtsListener> l = self.ttsListener;
            if (l && [l respondsToSelector:@selector(onTextFrame:)] && text) {
                dispatch_async(dispatch_get_main_queue(), ^{ [l onTextFrame:text]; });
            }
        }
        // 继续接收下一条
        dispatch_async(self->_queue, ^{
            if (self->_task) [self receiveLocked];
        });
    }];
}

#pragma mark - 上行

- (void)upload:(NSData *)pcm {
    if (!pcm || pcm.length == 0) return;
    dispatch_async(_queue, ^{
        if (!_enabled) return;
        if (!_task || !_connected) {
            NSTimeInterval now = CFAbsoluteTimeGetCurrent();
            if (now - _lastConnectAttempt > kReconnectInterval) {
                _lastConnectAttempt = now;
                if (!_task) [self connectLocked];
            }
            return;
        }
        NSURLSessionWebSocketMessage *msg = [[NSURLSessionWebSocketMessage alloc] initWithData:pcm];
        [_task sendMessage:msg completionHandler:^(NSError * _Nullable error) {
            if (error) NSLog(@"%@ upload send failed: %@", kTag, error.localizedDescription);
        }];
    });
}

- (void)sendText:(NSString *)text {
    if (!text) return;
    // 【关键日志·长期保留】记录调用时刻；出队后打印排队延迟，判断 200s 卡在「队列排队」还是「sendMessage 本身」。
    NSTimeInterval callAt = CFAbsoluteTimeGetCurrent();
    NSData *body = [text dataUsingEncoding:NSUTF8StringEncoding];
    dispatch_async(_queue, ^{
        NSTimeInterval deqAt = CFAbsoluteTimeGetCurrent();
        BOOL ready = (_task != nil && _connected);
        NSLog(@"%@ sendText queued=%.3fms connected=%d hasTask=%d", kTag,
              (deqAt - callAt) * 1000, _connected, _task != nil);
        if (!ready) {
            // 【关键日志·长期保留】旧实现这里静默 return 直接丢回执；改为暂存待连上补发。
            NSLog(@"%@ sendText PENDING (not connected, will flush on open)", kTag);
            if (body) [_pendingTexts addObject:body];
            return;
        }
        NSURLSessionWebSocketMessage *msg = [[NSURLSessionWebSocketMessage alloc] initWithString:text];
        NSTimeInterval sendAt = CFAbsoluteTimeGetCurrent();
        [_task sendMessage:msg completionHandler:^(NSError * _Nullable error) {
            NSTimeInterval doneAt = CFAbsoluteTimeGetCurrent();
            // 【关键日志·长期保留】completion 时延即回执真正写进 WS 的时刻；200s 若在这里就是 WS 层阻塞。
            NSLog(@"%@ sendText completion=%.3fms error=%@", kTag,
                  (doneAt - sendAt) * 1000, error ? error.localizedDescription : @"nil");
            if (error) NSLog(@"%@ sendText failed: %@", kTag, error.localizedDescription);
        }];
    });
}

- (void)stop {
    dispatch_async(_queue, ^{
        _enabled = NO;
        [_pendingTexts removeAllObjects];
        if (_task) {
            [_task cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
            _task = nil;
        }
        _connected = NO;
        NSLog(@"%@ stopped", kTag);
    });
}

#pragma mark - NSURLSessionWebSocketDelegate

- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask didOpenWithProtocol:(NSString *)protocol {
    dispatch_async(_queue, ^{
        if (webSocketTask == _task) {
            _connected = YES;
            NSLog(@"%@ connected", kTag);
            // 【关键日志·长期保留】连上后立刻补发断连期间暂存的文本回执（播空回执不能丢）。
            NSUInteger pending = _pendingTexts.count;
            if (pending > 0) NSLog(@"%@ flush pending text=%lu", kTag, (unsigned long)pending);
            for (NSData *body in _pendingTexts) {
                NSURLSessionWebSocketMessage *msg = [[NSURLSessionWebSocketMessage alloc] initWithData:body];
                [_task sendMessage:msg completionHandler:^(NSError * _Nullable error) {
                    NSLog(@"%@ flush text completion error=%@", kTag, error ? error.localizedDescription : @"nil");
                }];
            }
            [_pendingTexts removeAllObjects];
        }
    });
}

- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask didCloseWithCode:(NSURLSessionWebSocketCloseCode)code reason:(NSData *)reason {
    dispatch_async(_queue, ^{
        if (webSocketTask == _task) {
            _task = nil;
            _connected = NO;
            NSLog(@"%@ closed code=%ld", kTag, (long)code);
            if (_enabled) [self connectLocked]; // 断开自动重连
        }
    });
}

@end
