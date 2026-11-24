//
//  GatewayControlModule.h
//  app-product-gateway 原生插件（iOS / DCloud 离线 SDK）
//
//  职责：JS 侧点中间圆球/设置页「重启网关」时，调网关软重启端点恢复卡死的业务链路。
//  iOS 同进程、node_start 阻塞且无停止句柄，无法像 Android 那样 kill 进程重启；
//  改用网关层 /api/gateway/soft-restart（关 WS + 清健康缓存）做可控软重启。
//  硬卡死（8787 完全无响应）时本端点也调不通 → 回调 ok=false，前端诚实提示用户手动重启 App。
//
//  注册：Info.plist 的 dcloud_uniplugins 数组里
//        { name: app-product-gateway, class: GatewayControlModule, type: module }
//        （由 ios-integrate.rb 注入，与 app-product-wake 同机制）。
//

#import <Foundation/Foundation.h>
#import "DCUniModule.h"

@interface GatewayControlModule : DCUniModule

@end
