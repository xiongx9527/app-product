// 网关启动入口：供壳工程（HBuilder-Hello）的 AppDelegate.m 经 ObjC 调用。
//
// 为什么要这个类：原实现是 `extension AppDelegate`（AppDelegate+Gateway.swift），
// 但 Swift extension 编译期必须看到宿主类，无法进独立 framework；壳工程的 AppDelegate
// 是 ObjC（AppDelegate.m），因此改由本类暴露 @objc 静态方法，AppDelegate.m 直接
// `[GatewayLauncher startEmbeddedGateway]` 调用（见 XiaoxiongGateway-Swift.h 自动生成声明）。
//
// 集成由 package-ios-offline.mjs 自动完成（embed framework + patch AppDelegate.m），
// 不再需要手动拖文件。

import Foundation

@objc
public final class GatewayLauncher: NSObject {
    /// 在应用启动早期调用：后台线程拉起 Node 网关，并异步等端口就绪后写出 ws URL。
    /// 幂等（GatewayNode.start 内部保证），重复调用无害。
    @objc
    public static func startEmbeddedGateway() {
        GatewayNode.shared.start()
        GatewayNode.shared.awaitPort { url in
            NSLog("[gateway] 内嵌网关就绪，客户端可连接: \(url)")
        }
    }
}
