# iOS 离线 SDK 目录（native/ios/sdk）

本目录放 **DCloud 官方 iOS 离线 SDK 壳工程**（目录名统一为 `HBuilder-SDK`，与 Android 侧 `native/android/sdk/HBuilder-SDK` 同名），对齐 `native/android/sdk` 的「SDK 壳」位置。

## 获取与放置

iOS 离线 SDK 是 DCloud 分发的工程件（含 `.xcodeproj` / `.xcworkspace` / `Pandora/`，内层工程官方名叫 `HBuilder-Hello`），体积大，**不入库**。

1. 从 DCloud 官方下载 iOS 离线 SDK（5.34 等对应版本），解压得到 `HBuilder-Hello` 工程目录。
2. 将其整个放入本目录并**把目录改名为 `HBuilder-SDK`**（仅外层目录名；内层 `.xcodeproj` / `.xcworkspace` 保持官方名不动），使最终路径为：

   ```
   xiaoxiong-app/native/ios/sdk/HBuilder-SDK
   ```

   （即本文件同级出现 `HBuilder-SDK/` 与 `SDK/` 两个子目录。）

3. **`SDK/`（官方引擎目录，1.7G）也一并放入**：DCloud 包内壳工程旁还有个 `SDK/`
   （inc / Libs / Bundles 等），壳工程的 Pods 头文件符号链接按相对路径指到它
   （`Pods/Headers/**/uniapp/*.h -> ../../../../../SDK/inc/...`）。缺了它 954 个头文件悬空、
   Xcode 编译直接失败。最终布局：

   ```
   xiaoxiong-app/native/ios/sdk/
   ├── HBuilder-SDK/   # 壳工程（.xcodeproj / Pandora / Pods）
   └── SDK/            # 官方引擎 inc/Libs/Bundles（Pods 符号链接的指向）
   ```

   两个目录都已被 `.gitignore` 忽略。

4. **`uniapp.podspec`（DCloud 分发件）必须与本 README 同级**（`native/ios/sdk/uniapp.podspec`）：
   Podfile 的 `pod 'uniapp', :path => '..'` 指向壳工程上级目录，其内 `SDK/Libs`、`SDK/inc` 等相对路径
   都以 podspec 所在位置为基准。也已 gitignore。

5. **Pods 需要在迁移/换新后重新 `pod install`**（Pods 工程里存的是绝对路径，位置一变就失效）：

   ```sh
   cd xiaoxiong-app/native/ios/sdk/HBuilder-SDK
   PATH="$HOME/.gem/ruby/2.6.0/bin:$PATH" pod install   # pod 装在用户级 gem（Ruby 2.6，脚本已带 filter_map 兼容 shim）
   ```
   注意：本机 `pod` 在 `~/.gem/ruby/2.6.0/bin`（系统 Ruby），不在默认 PATH。

## 配置指向

- `native/ios/build.local` 的 `IOS_SDK` 已默认写成相对本目录的 `sdk/HBuilder-SDK`
  （由 `reprovision.sh` 相对 `native/ios` 解析；也可改为绝对路径或 `~/xxx`）。
- `scripts/build.sh` / `.build_env.<env>` 的 `IOS_SDK_DIR` 默认也是
  `native/ios/sdk/HBuilder-SDK`，无需每次手动指定；下载解压到位后即自动生效。

## 说明

- 真正的「原生工厂」（我们自己的原生源码 `GatewayNode.swift` / `GatewayLauncher.swift` + Xcode framework 工程）
  在 `native/ios/app/`，正常入库、不忽略。
- `HBuilder-SDK/` 本身已被 `.gitignore` 忽略，不会被提交。
