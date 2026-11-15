# iOS 离线 SDK 目录（native/ios/sdk）

本目录放 **DCloud 官方 iOS 离线 SDK 工程 `HBuilder-Hello`**，对齐 `native/android/sdk` 的「SDK 壳」位置。

## 获取与放置

iOS 离线 SDK 是 DCloud 分发的工程件（含 `.xcodeproj` / `.xcworkspace` / `Pandora/`），体积大，**不入库**。

1. 从 DCloud 官方下载 iOS 离线 SDK（5.34 等对应版本），解压得到 `HBuilder-Hello` 工程目录。
2. 将其整个放入本目录，使最终路径为：

   ```
   xiaoxiong-app/native/ios/sdk/HBuilder-Hello
   ```

   （即本文件同级出现 `HBuilder-Hello/` 子目录。）

## 配置指向

- `native/ios/build.local` 的 `IOS_SDK` 已默认写成相对本目录的 `sdk/HBuilder-Hello`
  （由 `reprovision.sh` 相对 `native/ios` 解析；也可改为绝对路径或 `~/xxx`）。
- `scripts/build.sh` / `.build_env.<env>` 的 `IOS_SDK_DIR` 默认也是
  `native/ios/sdk/HBuilder-Hello`，无需每次手动指定；下载解压到位后即自动生效。

## 说明

- 真正的「原生工厂」（我们自己的原生源码 `GatewayNode.swift` / `AppDelegate+Gateway.swift`）
  在 `native/ios/app/`，正常入库、不忽略。
- `HBuilder-Hello/` 本身已被 `.gitignore` 忽略，不会被提交。
