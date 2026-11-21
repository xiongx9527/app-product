//
//  AppProductWakeModule.h
//  app-product-wake 原生插件（iOS / DCloud 离线 SDK）
//
//  职责（与 Android WakeModule.java 对齐）：
//    PCM 采集（对话/唤醒的音频来源）：startPcm / stopPcm / onPcmFrame / onPcmError
//    KWS 常驻唤醒：start / stop / onWake / onError（sherpa-onnx，KwsEngine）
//    提示音：playCue / stopCue / onCueEnd（原生播放，复用采集会话）
//    TTS 播放：startPlayback / playPcm / stopPlayback / onPlaybackIdle / setPlaybackVolume
//              （AudioQueue 写 role=pcm 下发的 24k PCM；此前 iOS 无原生 TTS 播放）
//    配置：configureDirectUpload(deviceId) —— 开启 PcmUploader 原生直连网关（role=pcm），
//          上行 PCM 直推、下行 TTS 原生播放，绕开 iOS weex 桥传帧失效问题（NSData→[object NSData]）。
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
