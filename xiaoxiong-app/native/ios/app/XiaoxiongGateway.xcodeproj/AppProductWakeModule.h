//
//  AppProductWakeModule.h
//  app-product-wake 原生插件（iOS / DCloud 离线 SDK）
//
//  职责（与 Android WakeModule.java 的 PCM 采集部分、JS 侧 appCapture.ts 一一对应）：
//    PCM 采集（对话/唤醒的音频来源）：startPcm / stopPcm / onPcmFrame / onPcmError
//    配置：configureDirectUpload(deviceId) —— JS 回调透传模式下仅记录 deviceId，
//          音频仍经 onPcmFrame 回调给 JS、由 JS transport 送网关（与 Android 原生直连不同）。
//
//  上行契约：16k / 16bit / 单声道 / 32ms（512 sample = 1024 字节）分片，见 contracts/README.md。
//
//  注册：Info.plist 的 dcloud_uniplugins 数组里
//        { name: app-product-wake, class: AppProductWakeModule, type: module }（由 ios-integrate.rb 注入）。
//  非单例：JS 侧须缓存 requireNativePlugin 返回的实例。
//
//  权限：NSMicrophoneUsageDescription 已在 Info.plist；运行时授权由 JS 侧
//        uni.authorize('scope.record') 在 startPcm 前请求，本类只检查并回报。
//

#import <Foundation/Foundation.h>
#import "DCUniModule.h"

@interface AppProductWakeModule : DCUniModule

@end
