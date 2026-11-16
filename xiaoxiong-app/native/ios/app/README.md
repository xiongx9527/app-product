# iOS 原生工厂（native/ios/app）

对齐 Android 侧 `native/android/app` 的「原生工厂 + SDK 壳」分工：本目录是我们自己的原生源码与 Xcode 工程，**正常入库**；DCloud 分发的离线 SDK 壳在 `native/ios/sdk/HBuilder-SDK/`（体积大，已被 `.gitignore` 忽略）。

## 工程结构

```
native/ios/app/
├── XiaoxiongGateway.xcodeproj   # 工程包（源码收在包内，app/ 下不散放文件）
│   ├── GatewayNode.swift        # 后台线程调 node_start 跑网关 bundle，轮询端口回写 gateway.url
│   ├── GatewayLauncher.swift    # @objc 启动入口：AppDelegate.m 调 [GatewayLauncher startEmbeddedGateway]
│   └── project.pbxproj
└── README.md
```

> 源码 `.swift` 放在 `.xcodeproj` 包**内部**（约定：工程的一部分收进工程包，目录里不留零散文件）。

## 为什么是 framework + Launcher，而不是 AppDelegate extension

原实现是 `extension AppDelegate`（AppDelegate+Gateway.swift），但 Swift extension 编译期必须看到宿主类，**无法编进独立 framework**；壳工程的 AppDelegate 是 ObjC（AppDelegate.m），因此改由 `GatewayLauncher` 暴露 `@objc` 静态方法，壳工程经 `#import <XiaoxiongGateway/XiaoxiongGateway-Swift.h>` 调用。`AppDelegate+Gateway.swift` 已删除。

## 独立编译验证

```sh
cd xiaoxiong-app/native/ios/app
xcodebuild -project XiaoxiongGateway.xcodeproj -scheme XiaoxiongGateway \
  -configuration Release -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

工程通过相对路径 `../sdk/HBuilder-SDK/Frameworks/NodeMobile.xcframework` 链接 Node 运行时（仅 link 不 embed；壳工程负责 Embed & Sign，`node_start` 符号由它在运行期解析）。所以先按 `native/ios/sdk/README.md` 把 SDK 壳放到位。

## 与壳工程的集成（自动化）

不再手动拖文件。`xiaoxiong-app/scripts/package-ios-offline.mjs` 会：

1. 用上面命令构建 framework，产物拷到壳工程 `Frameworks/XiaoxiongGateway.framework`
2. 调 `scripts/ios-integrate.rb`（xcodeproj gem，幂等）完成：
   - `XiaoxiongGateway.framework` 加入主 target 并 Embed（sign on copy）
   - `NodeMobile.xcframework` 确保在 Embed 列表
   - 清理旧式手动注入的 `GatewayNode.swift` / `AppDelegate+Gateway.swift`（若存在）
   - patch `AppDelegate.m`：import 换 framework 头、调用换 `[GatewayLauncher startEmbeddedGateway]`
3. 壳工程的真机构建与装机见 `native/ios/reprovision.sh`

壳工程可随时重建/换新：放好官方 SDK 壳后重跑 package 脚本即可恢复全部集成。
