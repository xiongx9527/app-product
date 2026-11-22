#import "AppDelegate.h"
#import "WSProbe.h"

@interface AppDelegate ()
@property (strong, nonatomic) WSProbe *probe;
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
    UIViewController *vc = [[UIViewController alloc] init];
    vc.view.backgroundColor = [UIColor blackColor];
    UILabel *label = [[UILabel alloc] initWithFrame:CGRectInset(vc.view.bounds, 20, 100)];
    label.textColor = [UIColor greenColor];
    label.numberOfLines = 0;
    label.font = [UIFont systemFontOfSize:16];
    label.text = @"WS 写出延迟诊断\n看 syslog: [WSProbe] WRITE_LATENCY_MS\n每 2s 发一帧，观察 completion 是否卡几十秒";
    [vc.view addSubview:label];
    self.window.rootViewController = vc;
    [self.window makeKeyAndVisible];

    self.probe = [[WSProbe alloc] init];
    [self.probe start];
    return YES;
}

@end
