//
//  mac-usb-tunnel — iOS dev 联调 USB 端口转发 helper
//
//  把 Mac 上的 127.0.0.1:9529（语音代理）经 USB 暴露给 iOS 设备上的 dev 隧道（网关 JS
//  在设备 127.0.0.1:9529 起的 mux 端点）。等价 Android 的 `adb reverse tcp:9529 tcp:9529`，
//  但走 PeerTalk/usbmux，配置地址 127.0.0.1:9529 不变、与网络环境无关。
//
//  用法：
//    mac-usb-tunnel run [--port 9529] [--udid UDID]   前台运行（默认）
//    mac-usb-tunnel status                            查看进程/设备状态
//    mac-usb-tunnel stop                              停止后台实例
//
//  帧协议（与网关 src/embedded/iosDevTunnel.ts 一致）：
//    mux 字节流帧 = [u32 BE connId][u32 BE len][payload]，len<=1MB
//    connId=0 为控制帧：payload 首字节 'C' + u32 BE connId = 对端请求关闭该连接
//    连入后本端先写握手行 'XIAOXIONG-PTTUNNEL/1\n'
//
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <sys/socket.h>
#import <netinet/in.h>
#import <netinet/tcp.h>
#import <arpa/inet.h>
#import <pthread.h>
#import <unistd.h>
#import <errno.h>
#import <string.h>
#import "Peertalk/PTUSBHub.h"

static NSString *const kHandshake = @"XIAOXIONG-PTTUNNEL/1\n";
static NSString *const kLogPath = @"logs/ios-usb-tunnel.log";
static NSString *const kPidPath = @"logs/.ios-usb-tunnel.pid";
static const int kHeaderBytes = 8;
static const uint32_t kMaxFrame = 1024 * 1024;

// 全局：mux 通道（USB）与 connId→本地 socket 映射
static dispatch_io_t gMuxChannel = NULL;
static dispatch_queue_t gMuxQueue = NULL;       // 写队列
static dispatch_queue_t gMuxReadQueue = NULL;   // 读队列（与写分离，PeerTalk 要求读写不同队列）
static NSMutableDictionary<NSNumber *, NSNumber *> *gConns = nil; // connId -> socket fd
static NSLock *gConnsLock = nil;
static uint32_t gNextId = 1;
static NSMutableData *gMuxBuf = nil;
static int gTargetPort = 9529;
static NSString *gTargetUdid = nil;
static NSNumber *gCurrentDeviceID = nil;        // 在线设备的 usbmux deviceID（定时重连用）
static BOOL gLastConnectFailed = NO;            // 失败日志节流：只在状态翻转时打印

static void logLine(NSString *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:ap];
  va_end(ap);
  NSString *line = [NSString stringWithFormat:@"%@ %@\n", [NSDate date], msg];
  fprintf(stderr, "%s", line.UTF8String);
  NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:kLogPath];
  if (!fh) {
    [[NSFileManager defaultManager] createFileAtPath:kLogPath contents:nil attributes:nil];
    fh = [NSFileHandle fileHandleForWritingAtPath:kLogPath];
  }
  [fh seekToEndOfFile];
  [fh writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
  [fh closeFile];
}

static void sendFrame(uint32_t connId, const uint8_t *payload, uint32_t len) {
  if (!gMuxChannel) return;
  NSMutableData *frame = [NSMutableData dataWithCapacity:kHeaderBytes + len];
  uint32_t beId = htonl(connId);
  uint32_t beLen = htonl(len);
  [frame appendBytes:&beId length:4];
  [frame appendBytes:&beLen length:4];
  if (len) [frame appendBytes:payload length:len];
  dispatch_data_t data = dispatch_data_create(frame.bytes, frame.length,
                                              dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
                                              DISPATCH_DATA_DESTRUCTOR_DEFAULT);
  dispatch_io_write(gMuxChannel, 0, data, gMuxQueue, ^(bool done, dispatch_data_t _unused, int error) {
    if (error && done) logLine(@"mux 写帧失败 connId=%u err=%d", connId, error);
  });
}

static void sendClose(uint32_t connId) {
  uint8_t p[5];
  p[0] = 'C';
  uint32_t be = htonl(connId);
  memcpy(p + 1, &be, 4);
  sendFrame(0, p, 5);
}

// 本地连接读线程：把字节按帧发给 mux；对端关闭则退出。
// arg 直接用 connId 的整数值（ avoidance NSNumber bridge 生命周期问题）。
static void *localReadThread(void *arg) {
  uint32_t connId = (uint32_t)(uintptr_t)arg;
  int fd = 0;
  [gConnsLock lock];
  fd = gConns[@(connId)].intValue;
  [gConnsLock unlock];

  uint8_t buf[16384];
  while (fd > 0) {
    ssize_t n = read(fd, buf, sizeof(buf));
    if (n <= 0) break;
    sendFrame(connId, buf, (uint32_t)n);
  }
  close(fd);
  [gConnsLock lock];
  [gConns removeObjectForKey:@(connId)];
  [gConnsLock unlock];
  sendClose(connId);
  return NULL;
}

// 为 connId 建立到本地语音代理的 socket（127.0.0.1:gTargetPort），启动读线程。
static int openLocalConn(uint32_t connId) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { logLine(@"socket 失败 connId=%u errno=%d", connId, errno); return -1; }
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(gTargetPort);
  inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    logLine(@"连接 127.0.0.1:%d 失败 connId=%u errno=%d", gTargetPort, connId, errno);
    close(fd);
    return -1;
  }
  int flag = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
  [gConnsLock lock];
  gConns[@(connId)] = @(fd);
  [gConnsLock unlock];
  pthread_t th;
  pthread_create(&th, NULL, localReadThread, (void *)(uintptr_t)connId);
  pthread_detach(th);
  return fd;
}

// 持续从 mux 通道读：PeerTalk 的 dispatch_io 必须每次读一个"有限长度"，在 done=true
// 的回调里拿到数据后再次发起下一次读（模仿 PTProtocol 的 readFrame 模式）。用 SIZE_MAX
// 会导致通道缓冲到 EOF 才回调、期间收不到设备发来的帧。
static void handleMuxData(NSData *chunk); // 前向声明
static void pumpMuxRead(dispatch_io_t channel);
static void pumpMuxRead(dispatch_io_t channel) {
  if (!channel) return;
  dispatch_io_read(channel, 0, 64 * 1024, gMuxReadQueue, ^(bool done, dispatch_data_t data, int error) {
    if (data) {
      const uint8_t *p = NULL; size_t n = 0;
      dispatch_data_t flat = dispatch_data_create_map(data, (const void **)&p, &n);
      if (flat && p && n) {
        logLine(@"mux 读 %zu 字节", n);
        handleMuxData([NSData dataWithBytes:p length:n]);
      }
    }
    if (error) logLine(@"mux 读错误 err=%d", error);
    if (done && !error) {
      pumpMuxRead(channel); // 继续读下一批
    }
  });
}

// mux 收帧处理
static void handleMuxData(NSData *chunk) {
  if (!gMuxBuf) gMuxBuf = [NSMutableData data];
  [gMuxBuf appendData:chunk];
  const uint8_t *bytes = gMuxBuf.bytes;
  NSUInteger total = gMuxBuf.length;
  NSUInteger offset = 0;
  while (total - offset >= kHeaderBytes) {
    uint32_t connId = ntohl(*(const uint32_t *)(bytes + offset));
    uint32_t len = ntohl(*(const uint32_t *)(bytes + offset + 4));
    if (len > kMaxFrame) {
      logLine(@"帧过大 len=%u，断开", len);
      dispatch_io_close(gMuxChannel, DISPATCH_IO_STOP);
      return;
    }
    if (total - offset < kHeaderBytes + len) break;
    const uint8_t *payload = bytes + offset + kHeaderBytes;
    offset += kHeaderBytes + len;

    if (connId == 0) {
      if (len >= 5 && payload[0] == 'C') {
        uint32_t target = ntohl(*(const uint32_t *)(payload + 1));
        [gConnsLock lock];
        NSNumber *fdNum = gConns[@(target)];
        [gConnsLock unlock];
        if (fdNum) { close(fdNum.intValue); /* 读线程会清理映射 */ }
      }
      continue;
    }
    [gConnsLock lock];
    NSNumber *fdNum = gConns[@(connId)];
    [gConnsLock unlock];
    int fd = fdNum ? fdNum.intValue : -1;
    if (fd < 0) {
      logLine(@"收到新连接帧 connId=%u len=%u，建本地连接", connId, len);
      // 设备侧首次为某 connId 发数据 → 建本地连接（连 Mac 的语音代理）
      fd = openLocalConn(connId);
      if (fd < 0) { sendClose(connId); continue; }
      logLine(@"connId=%u 本地连接建立 fd=%d", connId, fd);
    }
    ssize_t written = 0;
    while (written < (ssize_t)len) {
      ssize_t w = write(fd, payload + written, len - written);
      if (w <= 0) break;
      written += w;
    }
    if (written < (ssize_t)len) {
      // 写失败：关闭该连接并通知设备
      close(fd);
      [gConnsLock lock];
      [gConns removeObjectForKey:@(connId)];
      [gConnsLock unlock];
      sendClose(connId);
    }
  }
  if (offset > 0) [gMuxBuf replaceBytesInRange:NSMakeRange(0, offset) withBytes:NULL length:0];
}

static void connectDevice(NSNumber *deviceID) {
  BOOL firstTry = !gLastConnectFailed; // 定时重连期间只在首次尝试打印
  if (firstTry) logLine(@"连接设备 deviceID=%@ port=%d", deviceID, gTargetPort);
  [[PTUSBHub sharedHub] connectToDevice:deviceID port:gTargetPort
    onStart:^(NSError *error, dispatch_io_t channel) {
      if (error || !channel) {
        if (!gLastConnectFailed) logLine(@"等待设备隧道（App 未前台/未启动？）: %@", error.localizedDescription);
        gLastConnectFailed = YES;
        return;
      }
      if (gLastConnectFailed) logLine(@"设备隧道已就绪，连接建立");
      gLastConnectFailed = NO;
      gMuxChannel = channel;
      gMuxQueue = dispatch_queue_create("mux.write", DISPATCH_QUEUE_SERIAL);
      gMuxReadQueue = dispatch_queue_create("mux.read", DISPATCH_QUEUE_SERIAL);
      [gConnsLock lock];
      [gConns removeAllObjects];
      [gConnsLock unlock];
      gMuxBuf = [NSMutableData data];
      logLine(@"mux 通道已建立，发握手");
      dispatch_data_t hs = dispatch_data_create(kHandshake.UTF8String, kHandshake.length,
                                                dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
                                                DISPATCH_DATA_DESTRUCTOR_DEFAULT);
      dispatch_io_write(channel, 0, hs, gMuxQueue, ^(bool done, dispatch_data_t _u, int e) {
        if (e) logLine(@"握手写失败 err=%d", e);
      });
      // 开始持续读 mux 帧（有限长度 + done 后递归，PeerTalk dispatch_io 标准模式）。
      pumpMuxRead(channel);
      // 通道断开时清理所有本地连接（pumpMuxRead 在 error 时也会走到这里由 onEnd 处理）。
    }
    onEnd:^(NSError *error) {
      // 无 mux 通道说明这次是"等待设备隧道"的失败尝试，不刷屏（定时重连每 2s 一次）；
      // 有通道关闭才是真实的连接断开。
      if (gMuxChannel) {
        logLine(@"mux 连接结束: %@", error.localizedDescription ?: @"normal");
        [gConnsLock lock];
        NSArray *fds = [gConns allValues];
        [gConns removeAllObjects];
        [gConnsLock unlock];
        for (NSNumber *f in fds) close(f.intValue);
        gMuxChannel = NULL;
      }
    }];
}

// 发现设备：优先用指定 udid（转 deviceID 需从通知属性取），否则取第一个 attach 的设备。
static void startWatching(void) {
  [[NSNotificationCenter defaultCenter] addObserverForName:PTUSBDeviceDidAttachNotification
    object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
      NSDictionary *props = note.userInfo[PTUSBHubNotificationKeyProperties];
      NSNumber *deviceID = note.userInfo[PTUSBHubNotificationKeyDeviceID];
      NSString *serial = props[@"SerialNumber"];
      if (gTargetUdid && ![serial isEqualToString:gTargetUdid]) return;
      logLine(@"发现设备 attach deviceID=%@ serial=%@", deviceID, serial);
      gCurrentDeviceID = deviceID;
      if (!gMuxChannel) connectDevice(deviceID);
    }];
  [[NSNotificationCenter defaultCenter] addObserverForName:PTUSBDeviceDidDetachNotification
    object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification *note) {
      logLine(@"设备 detach deviceID=%@", note.userInfo[PTUSBHubNotificationKeyDeviceID]);
      if ([[note.userInfo[PTUSBHubNotificationKeyDeviceID] description] isEqualToString:[gCurrentDeviceID description]]) {
        gCurrentDeviceID = nil;
      }
      if (gMuxChannel) { dispatch_io_close(gMuxChannel, DISPATCH_IO_STOP); gMuxChannel = NULL; }
    }];
  // sharedHub 自动进入监听；已 attach 的设备会补发通知。
  [PTUSBHub sharedHub];
  // 定时重连：设备 9529 可能此刻还没起来（App 未前台）。每 2s 在无通道时重试，
  // 这样用户稍后手动打开 App、隧道监听起来后能自动连上，无需重启 helper。
  // 用 NSTimer（走 main RunLoop，和 PTUSBHub 的设备通知同一个 RunLoop）。
  // 注意：RunLoop 需要至少一个 input source 才会持续运行，cmdRun 里会加 NSMachPort 保活。
  [NSTimer scheduledTimerWithTimeInterval:2.0 repeats:YES block:^(NSTimer *_Nonnull t) {
    if (!gMuxChannel && gCurrentDeviceID) connectDevice(gCurrentDeviceID);
  }];
}

static int cmdRun(int argc, const char *argv[]) {
  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) gTargetPort = atoi(argv[++i]);
    else if (strcmp(argv[i], "--udid") == 0 && i + 1 < argc) gTargetUdid = @(argv[++i]);
  }
  gConns = [NSMutableDictionary dictionary];
  gConnsLock = [NSLock new];
  logLine(@"启动 run port=%d udid=%@", gTargetPort, gTargetUdid ?: @"(任意)");
  // 写 pid 供 status/stop 使用（日志在 logs/ 下，需确保目录存在）
  [[NSFileManager defaultManager] createDirectoryAtPath:@"logs" withIntermediateDirectories:YES attributes:nil error:nil];
  [[@(getpid()).stringValue stringByAppendingString:@"\n"] writeToFile:kPidPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
  startWatching();
  // 保活 RunLoop：NSRunLoop 没有任何 input source 时 run 会立即返回，导致 NSTimer 不触发、
  // PTUSBHub 设备通知收不到。加一个 NSMachPort 作为常驻 source。
  NSMachPort *keepAlive = [NSMachPort new];
  [[NSRunLoop currentRunLoop] addPort:keepAlive forMode:NSDefaultRunLoopMode];
  [[NSRunLoop currentRunLoop] run];
  return 0;
}

static int cmdStatus(void) {
  NSFileManager *fm = [NSFileManager defaultManager];
  if ([fm fileExistsAtPath:kPidPath]) {
    NSString *pid = [NSString stringWithContentsOfFile:kPidPath encoding:NSUTF8StringEncoding error:nil];
    printf("mac-usb-tunnel 运行中 pid=%s\n", pid.UTF8String);
  } else {
    printf("mac-usb-tunnel 未运行\n");
  }
  printf("日志: %s\n", kLogPath.UTF8String);
  return 0;
}

static int cmdStop(void) {
  if ([[NSFileManager defaultManager] fileExistsAtPath:kPidPath]) {
    NSString *pid = [NSString stringWithContentsOfFile:kPidPath encoding:NSUTF8StringEncoding error:nil];
    int p = pid.intValue;
    if (p > 0) kill(p, SIGTERM);
    [[NSFileManager defaultManager] removeItemAtPath:kPidPath error:nil];
    printf("已停止 pid=%d\n", p);
  } else {
    printf("未运行\n");
  }
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2) { printf("用法: mac-usb-tunnel run|status|stop\n"); return 1; }
    if (strcmp(argv[1], "status") == 0) return cmdStatus();
    if (strcmp(argv[1], "stop") == 0) return cmdStop();
    if (strcmp(argv[1], "run") == 0) return cmdRun(argc, argv);
    printf("未知命令: %s\n", argv[1]);
    return 1;
  }
}
