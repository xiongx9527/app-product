# 原生层加载网关骨架（Android / iOS）

本目录是「网关同包」方案的**原生启动骨架**：原生层加载 digidem/nodejs-mobile 运行时（Node 24.20.0，full flavour），在其内启动 `gateway.bundle.mjs`。两端统一，单一运行时。

> 运行时选型详见 `docs/mobile-embedded-gateway.md` §12/#1、#9、§14 B1。iOS 包**无 x86_64 模拟器切片**，本机 Intel Mac 模拟器跑不了，iOS 联调需真机（arm64 iPad）或 Apple Silicon Mac。

## 启动契约（两端一致）

原生层做三件事后调用 Node 入口：

1. **解包资产**：首启把 `gateway.bundle.mjs` + `static/cues/*` 从 App 资产拷到私有目录（`GATEWAY_HOME`）。
2. **setenv 环境**（必须在 `node_start` / `node::Start` 之前，变量只读取一次）：
   | 变量 | Android | iOS | 说明 |
   |---|---|---|---|
   | `GATEWAY_HOME` | ✅ 私有目录 | ✅ 私有目录 | bundle 与 db/cues 根 |
   | `GATEWAY_MODE` | `embedded` | `embedded` | server.ts 据此只绑 `127.0.0.1` |
   | `DOCS_ENABLED` | `false` | `false` | 离线无 `node_modules`，禁用 `/docs` |
   | `GATEWAY_PORT` | `0` | `0` | 系统分配端口 |
   | `GATEWAY_PORT_FILE` | `<home>/.gateway_port` | `<home>/.gateway_port` | 实际端口回写文件 |
   | `TMPDIR` | `getCacheDir()` | 系统已设 | **Android 必须**，否则 `os.tmpdir()` 落到不存在的 `/tmp` |
   | `HOME` | 应用目录 | 应用目录 | `os.homedir()` 可用 |
   | `NODE_COMPILE_CACHE` | `<cache>/node-cache` | `<Caches>/gateway-node-cache` | V8 代码缓存，加速冷启 |
   | `NODE_COMPILE_CACHE_PORTABLE` | — | `1` | iOS 容器路径含 UUID，避免缓存失效 |
   | `NODE_OPTIONS` | `--max-old-space-size-percentage=50 --enable-source-maps` | 同左 | 后台运行时按百分比限堆，防 cgroup 杀进程 |
3. **调用入口**：
   - iOS：`node_start(int argc, char *argv[])`（来自 `NodeMobile.framework`，阻塞，**必须在后台线程调**）。
   - Android：`node::Start(int argc, char* argv[])`（来自 `libnode.so`，经 `gateway_node_bridge.cpp` 的 JNI 在 `std::thread` 里调，避免卡 Service 主线程）。
   - `argv = ["node", "<GATEWAY_HOME>/gateway.bundle.mjs"]`。

## 端口回传协议

`node_start` / `node::Start` 阻塞事件循环，bundle 内的 `src/embedded/entry.ts` 在 `listening` 后把实际端口写进 `GATEWAY_PORT_FILE`。原生层**轮询该文件**（Android `GatewayNodeService.pollPort` / iOS `GatewayNode.awaitPort`），读到后注入客户端 `ws://127.0.0.1:<port>`。客户端 `core/transport` 据此建连（回环，不暴露局域网）。

## 资产布局

```
native/android/
  GatewayNodeService.java     # :gateway 独立进程 Service
  gateway_node_bridge.cpp    # JNI 桥：setenv + node::Start（后台线程）
  CMakeLists.txt             # 编 libgatewaynode.so，链接 digidem libnode
native/ios/
  GatewayNode.swift          # 后台线程调 node_start，轮询端口
gateway/src/embedded/
  entry.ts                   # bundle 入口：起网关 + 写端口文件（build:bundle 已指向它）
```

打包脚本 `uni_app/scripts/package-android-offline.mjs` 已把 `gateway.bundle.mjs` 与 `static/cues` 接入 Android 工程 `assets/gateway/`，并把 digidem 各 ABI 的 `libnode.so` 拷进 `jniLibs/<abi>/`：

```sh
node xiaoxiong-app/uni_app/scripts/package-android-offline.mjs \
  --sdk ~/Downloads/Android-SDK@5.34.../HBuilder-Integrate-AS \
  --appid __UNI_XXXXXXXX --appkey <AppKey> \
  --node-lib <digidem-android 包解压目录>   # nodejs-mobile-android-24.20.0-0.zip
```

- `--node-lib` 指向 digidem android 包解压目录（结构 `bin/<abi>/libnode.so` + `include/node/`）；脚本递归找 `libnode.so`、按父目录名判 ABI。不提供则只接资产、APK 不含运行库（内嵌网关起不来）。
- **`libnode.so` 还依赖共享 C++ 运行库 `libc++_shared.so`**：digidem Node 24 以共享 STL 链接，APK 必须把它也打进 `jniLibs/<abi>/`（NDK 路径 `<ndk>/toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/<abi>/libc++_shared.so`）。漏掉会在 `System.loadLibrary("node")` 处 `UnsatisfiedLinkError`，`:gateway` 进程秒崩（见下方排查清单）。
- `--no-gateway` 可退回纯 uni-app 资源接入；`--gateway-bundle` / `--gateway-cues` 可覆盖默认路径。
- `assets/gateway/` 布局：`gateway.bundle.mjs`（顶层）+ `static/cues/*.mp3`（子目录，对应 `server.ts` 的 `CUE_DIR=<GATEWAY_HOME>/static/cues`）。`GatewayNodeService.extractAssets` 递归把整个目录拷到 `no_backup`。

## Android 集成（DCloud 离线 SDK `HBuilder-Integrate-AS/simpleDemo`）

**2026-11-10 已落位到真实工程并 `assembleDebug` 验证通过**（本机 SDK 工程路径见 `~/Downloads/Android-SDK@5.34.../HBuilder-Integrate-AS`）：

1. **Java**：`GatewayNodeService.java` → `src/main/java/com/xiaoxiong/assistant/gateway/GatewayNodeService.java`。
   - `static { System.loadLibrary("node"); System.loadLibrary("gatewaynode"); }`：先显式加载 `libnode.so` 再加载 JNI 桥，保证 `DT_NEEDED` 解析。
   - 用 `java.io`（`BufferedReader`/`FileInputStream`）读端口文件，**不用 `java.nio.file`**（后者 Android API 26+ 才有，本工程 minSdk 21）。
2. **Manifest**：`<application>` 内已声明 `<service android:name="com.xiaoxiong.assistant.gateway.GatewayNodeService" android:process=":gateway" android:exported="false"/>`（未碰 `dcloud_appkey`）。
3. **JNI 桥源码**：`gateway_node_bridge.cpp` + `CMakeLists.txt` → `src/main/cpp/`；digidem `include/node/` 头（132 个）→ `src/main/cpp/include/node/`（编译期用）。
   - `CMakeLists.txt` 自包含：按 `${ANDROID_ABI}` 选 `../jniLibs/${ANDROID_ABI}/libnode.so`，用 IMPORTED target 链接，不依赖脚本注入变量/绝对路径。
4. **build.gradle 条件式接线**：检测 SDK 是否装了 NDK+CMake 组件，**有才激活** `externalNativeBuild`（编 `libgatewaynode.so`）并设 `ndk.abiFilters` 到 3 个已有 ABI；**没有就跳过**，保证纯 Java/资源 APK 仍可编译。
   ```sh
   sdkmanager "ndk;27.0.12077973" "cmake;3.22.1"   # AGP 8.7.3 默认版本；之后重新 Sync/编译，无需改 build.gradle
   ```
5. **CMakeLists 必须 C++20**（`set(CMAKE_CXX_STANDARD 20)`）：digidem Node 24 的 `v8config.h` 硬性检查「C++20 or later required」，C++17 编译会直接失败（本机实测踩过）。
6. **仍待做**：App 启动时 `startService(new Intent(this, GatewayNodeService.class))`（当前没有启动点，属 `app-product-wake` 原生工程）；UI 进程读取 `.gateway_port` 后注入 `ws` URL；真实 appid/AppKey（装机运行必需）。

**验证（2026-11-10，装 NDK 后）**：`sdkmanager` 装 NDK 27 + CMake 3.22.1 → 条件式接线自动激活 `externalNativeBuild`（`gradlew` 打印「NDK/CMake 就绪：已启用 JNI 桥编译」）。改 C++20 后 `gradlew :simpleDemo:assembleDebug --offline` → **BUILD SUCCESSFUL**，三 ABI `libgatewaynode.so`（arm64 1.9M / v7a 1.4M / x86_64 1.8M）产出。**JNI 链接验证**：`libgatewaynode.so` 的 `DT_NEEDED` 含 `libnode.so`、未决符号 `U _ZN4node5StartEiPPc` 由 libnode.so 以 `T` 导出提供、JNI 入口 `..._nativeStartNode` 三 ABI 均 `T` 导出且与 Java 包名匹配；APK 内 `libgatewaynode.so`(1.1M) + `libnode.so`(87M) + `gateway.bundle.mjs`(2.0M) + 5 cues 全部打包。详见文档 §15。

## iOS 集成（DCloud 离线 SDK `HBuilder-Hello`，需另行获取）

脚本 `uni_app/scripts/package-ios-offline.mjs` 已对齐 Android 版的「资源 + 网关同包」接入，自动完成文件/plist 级工作并生成 Xcode 手动清单：

```sh
node xiaoxiong-app/uni_app/scripts/package-ios-offline.mjs \
  --sdk ~/Downloads/latest/5.34/HBuilder-Hello \   # iOS 离线 SDK 工程根（含 .xcodeproj 与 Pandora/）
  --appid __UNI_XXXXXXXX \
  --appkey <AppKey> \
  --node-ios <digidem-ios 包解压目录>             # nodejs-mobile-ios-24.20.0-0，内含 NodeMobile.xcframework（full）
```

脚本自动做：① 资源 → `Pandora/apps/<appid>/www`（修正 manifest id + `dcloud_control.xml`）；② AppKey → 主目标 `Info.plist` 的 `dcloud_appkey`；③ `UIBackgroundModes: audio` → `Info.plist`；④ 网关资产 → `<工程>/gateway/`（gateway.bundle.mjs + static/cues，首启由 `GatewayNode.swift` 从 App Bundle 解包到 `GATEWAY_HOME`）；⑤ `NodeMobile.xcframework` → `<工程>/Frameworks/`；⑥ 生成 `GATEWAY_INTEGRATION.md`（Xcode 手动步骤清单）。

**Xcode 里仍需手动点几下**（脚本无法改 .pbxproj，且需本机签名），详见生成的 `GATEWAY_INTEGRATION.md`：
1. 把 `native/ios/GatewayNode.swift` + `AppDelegate+Gateway.swift` 拖入主 target。
2. 在 AppDelegate 的 `application(_:didFinishLaunchingWithOptions:)` 调用 `GatewayNode.shared.start()` / `xiaoxiong_startEmbeddedGateway()`。
3. 把 `<工程>/gateway/` 作为 **folder reference** 加入主 target（Copy Bundle Resources）；`GatewayNode.swift` 从 `Bundle.main` 的 `subdirectory:"gateway"` 读取。
4. 把 `<工程>/Frameworks/NodeMobile.xcframework` 加入 Embedded Binaries 并 **Embed & Sign**（必须用 **full** flavour，lite 会让网关 `\p{...}` 正则崩溃）。
5. 真机（arm64 iPad）+ 开发者签名；Bundle Identifier 设 `com.xiaoxiong.assistant`（须与 AppKey 申请时一致）。

端口回传：bundle 写 `GATEWAY_HOME/.gateway_port` → `GatewayNode.awaitPort` 轮询后写出 `Documents/gateway.url`（`ws://127.0.0.1:<port>/ws`），客户端经 `plus.io` 读 `_documents/gateway.url` 注入 WS。

**本机 Intel Mac 无法在模拟器联调**（digidem iOS 包无 x86_64 切片），用真机（arm64 iPad）或 Apple Silicon Mac。

## 已知风险 / TODO

- **iOS 无 x86_64 模拟器切片**：联调只能真机（§10 #6）。
- **JNI 桥未编译验证**：需在 NDK 环境用 digidem 的 `include/node` 与 `libnode.so` 编 `libgatewaynode.so`；`node::Start` 签名以 digidem 头文件为准。
- **Swift `node_start` 调用约定**：`@_silgen_name` 桥接到 C，argv 内存管理需实机/编译验证（本机无 iOS SDK 可编）。
- **端口轮询超时/失败**处理：骨架为 60s 轮询，需补「启动失败」上报与客户端降级提示。
- **node:sqlite 路径**：`config_store` 用 `no_backup` 目录建库（见 `db/client.ts`），首启确保父目录存在（bundle 已处理，勿重复建）。
- **`libnode.so` 加载报 `UnsatisfiedLinkError: libc++_shared.so not found`**：`:gateway` 进程在 `static { System.loadLibrary("node") }` 处直接崩溃，ActivityManager 反复重启该 Service（logcat 可见 `Process com.xiaoxiong.assistant:gateway has died`）。**原因**：digidem Node 24 的 `libnode.so` 以**共享** C++ STL 链接，APK 未打包 `libc++_shared.so`。**修复**：从 NDK 对应 ABI 目录复制 `libc++_shared.so` 到 `src/main/jniLibs/<abi>/`（映射：arm64-v8a←aarch64-linux-android、armeabi-v7a←arm-linux-androideabi、x86_64←x86_64-linux-android），重新 `installDebug` 即过。**实测**（2026-11-10）：补完后模拟器 `emulator-5554` 上 Node 正常起在 `127.0.0.1:36001`，`GatewayNodeService` 写出 `gateway.url=ws://127.0.0.1:36001/ws`，`nc` 探活端口 OPEN；AppKey 已写入 manifest `dcloud_appkey`，启动即过 DCloud 校验。
- **HTTPS 外部服务信任**：连外部 LLM/ASR/TTS 默认走 Node 内置 Mozilla 根证书；若需私有 CA 用 `NODE_EXTRA_CA_CERTS` 指 PEM。
