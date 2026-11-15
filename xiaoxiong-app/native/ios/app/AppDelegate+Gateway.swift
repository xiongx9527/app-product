// DCloud iOS 离线工程（HBuilder-Hello）的 AppDelegate 钩子：引擎就绪后启动内嵌网关。
//
// 用法（在 Xcode 里把本文件加入主 target）：
//   1. 打开 HBuilder-Hello 工程的 AppDelegate（通常叫 AppDelegate.swift / AppDelegate.m）；
//   2. 在 `application(_:didFinishLaunchingWithOptions:)` 返回前加一行：
//        GatewayNode.shared.start()
//        GatewayNode.shared.awaitPort { url in
//          NSLog("[gateway] 内嵌网关就绪: \(url)")
//        }
//   3. 把本文件（GatewayNode.swift + AppDelegate+Gateway.swift）一并加入主 target；
//      把 NodeMobile.xcframework 加入 Embedded Binaries（见 package-ios-offline.mjs 生成的 GATEWAY_INTEGRATION.md）。
//
// DCloud 离线工程的 AppDelegate 类名通常是 `AppDelegate`（UIResponder, UIApplicationDelegate）。
// 若你的 SDK 里类名不同，把下面的 extension 目标类名改成对应的即可。

import Foundation
import UIKit

extension AppDelegate {
    /// 在应用启动早期调用：后台线程拉起 Node 网关，并异步等端口就绪后写出 ws URL。
    /// 由 AppDelegate.application(_:didFinishLaunchingWithOptions:) 显式调用，不依赖 DCloud 内部回调时机。
    @objc func xiaoxiong_startEmbeddedGateway() {
        GatewayNode.shared.start()
        GatewayNode.shared.awaitPort { url in
            NSLog("[gateway] 内嵌网关就绪，客户端可连接: \(url)")
        }
    }
}
