//
//  GatewayControlModule.m
//  app-product-gateway 原生插件（iOS）
//
//  restartGateway: 用 NSURLSession POST http://127.0.0.1:8787/api/gateway/soft-restart，
//  网关关掉所有 WS + 清健康探测缓存，前端重连拿干净会话。仅回环地址，不暴露局域网。
//  超时（3s）视为失败，回调 {ok:false}，前端播 gatewayDown 提示用户手动重启 App（不谎称恢复）。
//

#import "GatewayControlModule.h"

@implementation GatewayControlModule

UNI_EXPORT_METHOD(@selector(restartGateway:))

/// JS: plugin.restartGateway((r) => ...)  回调 {ok:BOOL}
- (void)restartGateway:(UniModuleKeepAliveCallback)callback {
    NSLog(@"[gateway-control] restartGateway (soft) requested");
    NSURL *url = [NSURL URLWithString:@"http://127.0.0.1:8787/api/gateway/soft-restart"];
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:url
                                                     cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                 timeoutInterval:3.0];
    req.HTTPMethod = @"POST";

    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:req
        completionHandler:^(NSData * _Nullable data, NSURLResponse * _Nullable response, NSError * _Nullable error) {
            BOOL ok = NO;
            if (!error && response) {
                NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
                if (http.statusCode >= 200 && http.statusCode < 300 && data) {
                    NSDictionary *body = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                    ok = [body isKindOfClass:[NSDictionary class]] && [body[@"ok"] boolValue];
                }
            }
            NSLog(@"[gateway-control] soft-restart result ok=%d error=%@", ok, error ?: @"none");
            if (callback) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    callback(@{ @"ok": @(ok) }, NO);  // NO = 非 keepAlive，一次性回调
                });
            }
        }];
    [task resume];
}

@end
