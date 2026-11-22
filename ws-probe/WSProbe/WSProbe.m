#import "WSProbe.h"
#import <CommonCrypto/CommonDigest.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <arpa/inet.h>
#import <unistd.h>

static NSString *const kTag = @"[WSProbe]";

@implementation WSProbe {
    int _listenFd;
    int _clientFd;
    dispatch_queue_t _serverQueue;
    NSURLSessionWebSocketTask *_task;
    NSURLSession *_session;
    NSInteger _seq;
    NSTimer *_sendTimer;
    NSTimer *_downlinkTimer;
    NSLock *_writeLock;
    BOOL _handshaked;
}

- (void)start {
    NSLog(@"%@ === WS 写出延迟诊断启动 ===", kTag);
    NSLog(@"%@ 目标: 同一 App 进程内 server(8787) + NSURLSessionWebSocketTask client", kTag);
    _serverQueue = dispatch_queue_create("wsprobe.server", DISPATCH_QUEUE_SERIAL);
    _writeLock = [[NSLock alloc] init];

    // 1) 起本地 WS server
    [self startServer];

    // 2) 延迟 0.5s 等 server listen 起来后启动客户端
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                   dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        [self startClient];
    });
}

#pragma mark - 本地 WS server（BSD socket 极简实现）

- (void)startServer {
    _listenFd = socket(AF_INET, SOCK_STREAM, 0);
    if (_listenFd < 0) { NSLog(@"%@ server socket 失败 errno=%d", kTag, errno); return; }
    int yes = 1;
    setsockopt(_listenFd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(8787);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(_listenFd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        NSLog(@"%@ bind(8787) 失败 errno=%d", kTag, errno); close(_listenFd); return;
    }
    if (listen(_listenFd, 4) < 0) { NSLog(@"%@ listen 失败 errno=%d", kTag, errno); close(_listenFd); return; }
    NSLog(@"%@ server listening 127.0.0.1:8787", kTag);

    dispatch_async(_serverQueue, ^{
        struct sockaddr_in peer;
        socklen_t plen = sizeof(peer);
        int fd = accept(self->_listenFd, (struct sockaddr *)&peer, &plen);
        if (fd < 0) { NSLog(@"%@ accept 失败 errno=%d", kTag, errno); return; }
        self->_clientFd = fd;
        NSLog(@"%@ server accepted client", kTag);
        [self serverHandshakeAndLoopOnFd:fd];
    });
}

/// 读 HTTP 握手头，回 101；然后循环读 WS 帧
- (void)serverHandshakeAndLoopOnFd:(int)fd {
    // 读请求头直到 \r\n\r\n
    NSMutableData *header = [NSMutableData data];
    char buf[4096];
    while (![self hasHeaderEnd:header]) {
        ssize_t n = recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) { NSLog(@"%@ handshake recv 结束 n=%zd errno=%d", kTag, n, errno); return; }
        [header appendBytes:buf length:n];
        if (header.length > 65536) { NSLog(@"%@ handshake 头过大", kTag); return; }
    }
    NSString *headStr = [[NSString alloc] initWithData:header encoding:NSUTF8StringEncoding] ?: @"";
    NSString *key = nil;
    for (NSString *line in [headStr componentsSeparatedByString:@"\r\n"]) {
        if ([line.lowercaseString hasPrefix:@"sec-websocket-key:"]) {
            key = [[line substringFromIndex:18] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
            break;
        }
    }
    if (!key) { NSLog(@"%@ 无 Sec-WebSocket-Key", kTag); return; }
    NSString *accept = [self wsAcceptForKey:key];
    NSString *resp = [NSString stringWithFormat:
        @"HTTP/1.1 101 Switching Protocols\r\n"
        @"Upgrade: websocket\r\n"
        @"Connection: Upgrade\r\n"
        @"Sec-WebSocket-Accept: %@\r\n\r\n", accept];
    const char *r = resp.UTF8String;
    ssize_t sent = send(fd, r, strlen(r), 0);
    NSLog(@"%@ server 101 已回 sent=%zd", kTag, sent);
    self->_handshaked = YES;

    // 启动 server→client 二进制下行（模拟 TTS），制造与真机一样的并发负载
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        [self serverDownlinkLoop];
    });

    // 循环读客户端帧
    [self serverReadFramesOnFd:fd startSeq:0];
}

- (BOOL)hasHeaderEnd:(NSData *)d {
    if (d.length < 4) return NO;
    const char *p = d.bytes;
    for (NSUInteger i = 0; i + 3 < d.length; i++) {
        if (p[i]=='\r' && p[i+1]=='\n' && p[i+2]=='\r' && p[i+3]=='\n') return YES;
    }
    return NO;
}

/// 正确读帧循环：C 数组接收 + 累积缓冲解析
- (void)serverReadFramesOnFd:(int)fd startSeq:(NSInteger)startSeq {
    NSMutableData *pending = [NSMutableData data];
    char tmp[8192];
    NSInteger seq = startSeq;
    while (YES) {
        ssize_t n = recv(fd, tmp, sizeof(tmp), 0);
        if (n <= 0) { NSLog(@"%@ server frames recv 结束 n=%zd errno=%d", kTag, n, errno); break; }
        [pending appendBytes:tmp length:n];
        // 解析尽可能多的完整帧
        while (pending.length >= 2) {
            const unsigned char *p = pending.bytes;
            unsigned char b0 = p[0], b1 = p[1];
            BOOL masked = (b1 & 0x80) != 0;
            NSUInteger len = b1 & 0x7f;
            NSUInteger offset = 2;
            if (len == 126) {
                if (pending.length < 4) break;
                len = (p[2]<<8) | p[3]; offset = 4;
            } else if (len == 127) {
                if (pending.length < 10) break;
                len = 0;
                for (int i=0;i<8;i++) len = (len<<8) | p[2+i];
                offset = 10;
            }
            if (masked) offset += 4;
            if (pending.length < offset + len) break; // 帧不完整，等下次
            // 帧完整（这里只关心到达时刻，不解析文本）
            const char *payload = (const char *)p + offset;
            NSString *text = [[NSString alloc] initWithBytes:payload length:MIN(len,80) encoding:NSUTF8StringEncoding] ?: @"(binary)";
            seq++;
            NSLog(@"%@ SERVER_RECV seq=%ld len=%lu text=%@", kTag, (long)seq, (unsigned long)len, text);
            NSMutableData *rest = [NSMutableData dataWithData:[pending subdataWithRange:NSMakeRange(offset+len, pending.length-offset-len)]];
            pending = rest;
        }
    }
}

/// server→client 每 100ms 一个二进制帧（WS server 发帧不 mask）
- (void)serverDownlinkLoop {
    int i = 0;
    while (self->_handshaked && self->_clientFd > 0) {
        @autoreleasepool {
            // 构造一个 4KB 二进制帧：opcode=2, len=126 + 2字节长度
            NSUInteger payloadLen = 4096;
            NSMutableData *frame = [NSMutableData data];
            unsigned char h0 = 0x82; // FIN + binary
            unsigned char h1 = 0x7e; // len=126
            unsigned char l0 = (payloadLen >> 8) & 0xff;
            unsigned char l1 = payloadLen & 0xff;
            [frame appendBytes:&h0 length:1];
            [frame appendBytes:&h1 length:1];
            [frame appendBytes:&l0 length:1];
            [frame appendBytes:&l1 length:1];
            char payload[4096]; memset(payload, 0, sizeof(payload));
            [frame appendBytes:payload length:payloadLen];
            ssize_t sent = send(self->_clientFd, frame.bytes, frame.length, 0);
            if (sent < 0) { NSLog(@"%@ downlink send 失败 errno=%d", kTag, errno); break; }
            i++;
            if (i % 50 == 0) NSLog(@"%@ DOWNLINK_SENT frames=%d", kTag, i);
        }
        usleep(100000); // 100ms
    }
}

#pragma mark - 客户端 NSURLSessionWebSocketTask

- (void)startClient {
    NSURLSessionConfiguration *cfg = [NSURLSessionConfiguration defaultSessionConfiguration];
    _session = [NSURLSession sessionWithConfiguration:cfg delegate:nil delegateQueue:nil];
    NSURL *url = [NSURL URLWithString:@"ws://127.0.0.1:8787"];
    _task = [_session webSocketTaskWithURL:url];
    [_task resume];
    // 等 didOpen（靠轮询 isConnected 近似：直接延迟 0.3s 开始发）
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.3 * NSEC_PER_SEC)),
                   dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        [self receiveLoop];
        [self startSendTimer];
        NSLog(@"%@ client 开始每 2s 发文本帧", kTag);
    });
}

- (void)receiveLoop {
    __weak typeof(self) weakSelf = self;
    [_task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage * _Nullable msg, NSError * _Nullable err) {
        if (err) { NSLog(@"%@ client receive error=%@", kTag, err.localizedDescription); return; }
        [weakSelf receiveLoop];
    }];
}

- (void)startSendTimer {
    dispatch_async(dispatch_get_main_queue(), ^{
        self->_sendTimer = [NSTimer scheduledTimerWithTimeInterval:2.0 repeats:YES block:^(NSTimer * _Nonnull timer) {
            [self sendOneTextFrame];
        }];
    });
}

- (void)sendOneTextFrame {
    _seq++;
    NSInteger seq = _seq;
    NSString *text = [NSString stringWithFormat:@"{\"type\":\"probe\",\"seq\":%ld}", (long)seq];
    NSURLSessionWebSocketMessage *msg = [[NSURLSessionWebSocketMessage alloc] initWithString:text];
    NSTimeInterval t0 = CFAbsoluteTimeGetCurrent();
    NSLog(@"%@ WRITE_START seq=%ld t=%.3f", kTag, (long)seq, t0);
    [_task sendMessage:msg completionHandler:^(NSError * _Nullable error) {
        NSTimeInterval t1 = CFAbsoluteTimeGetCurrent();
        double ms = (t1 - t0) * 1000;
        // 这是决定性指标：sendMessage completion 延迟
        NSLog(@"%@ WRITE_LATENCY_MS=%.1f seq=%ld error=%@", kTag, ms, (long)seq, error ? error.localizedDescription : @"nil");
    }];
}

#pragma mark - WS 握手 Accept 计算（RFC6455）

- (NSString *)wsAcceptForKey:(NSString *)key {
    NSString *concat = [key stringByAppendingString:@"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"];
    const char *c = concat.UTF8String;
    unsigned char digest[CC_SHA1_DIGEST_LENGTH];
    CC_SHA1(c, (CC_LONG)strlen(c), digest);
    NSData *d = [NSData dataWithBytes:digest length:CC_SHA1_DIGEST_LENGTH];
    return [d base64EncodedStringWithOptions:0];
}

@end
