# Node 网关与 App 同包（双进程）架构方案与改造清单

> 状态：**方案待确认，未实施**。本轮只出方案与清单，不动业务代码。
> 目标端：Android / iOS App（DCloud App 离线 SDK 本地打包）；H5 仅开发阶段调试；小程序与 HarmonyOS 确定不做。

## 1. 现状

| 项 | 现状 |
|---|---|
| 网关 | Node 22 + TypeScript，`tsx src/server.ts`，HTTP `:8787` + WS `/ws` |
| 客户端 | uni-app Vue3，WS 地址唯一来源 `VITE_GATEWAY_WS_URL`（构建期注入） |
| 部署 | 网关跑在 PC/服务器；手机通过局域网连过去（当前 H5 实测为 `:5173` → `127.0.0.1:8787`） |
| AI 服务 | ASR/TTS → `192.168.1.100:9529`（SenseVoice / Kokoro）；LLM → Ollama `127.0.0.1:11434` |
| 存储 | `node:sqlite`（Node 内置）+ drizzle-orm，落 `./data/app.db` |
| 原生插件 | `app-product-wake`（sherpa-onnx KWS）—— **目前只有 JS 桥接，原生工程尚未落地** |

## 2. 关键约束（已查证）

### 2.1 Android 与 iOS 的进程模型不同

| | Android | iOS |
|---|---|---|
| 独立进程 | ✅ 支持 `android:process=":gateway"` | ❌ **不允许 spawn 新进程**，nodejs-mobile 文档明确 |
| 后台常驻 | 前台服务 FGS + 常驻通知 + 声明 type（Android 14+ 已有 `microphone` 类型） | 退后台很快被挂起；需 `audio` background mode（持续录音是正当理由），超时/高 CPU 会被 watchdog 杀 |
| 后台调度 | WorkManager（可靠） | BGTaskScheduler（系统挑时间，不保证） |

**结论**：字面「2 个进程」只在 Android 成立；iOS 只能是 App 进程内的 Node 后台线程。逻辑上两端仍都是「App 运行时 + 网关运行时」两套，只是 iOS 共用一个 OS 进程。

### 2.2 nodejs-mobile 的三处硬伤

1. **停更**：最新 v18.20.4（2024-10），Node 18 已 EOL；未发布的 Node 22 分支还在开发；Android 16KB 页对齐未修，Google Play 自 2027-02 对 target Android 15+ 强制。
2. **没有 `node:sqlite`**（Node 22.5+ 才内置）—— 网关 `db/client.ts` 正是用它，drizzle-orm/node-sqlite 依赖它。
3. **`child_process` / `cluster` / `intl` / V8 inspector 不支持**；`process.exit()` 在 iOS 会终止整个 App（App Store 禁止）；iOS 不支持 WebAssembly/JIT。

### 2.3 网关不是自包含的

- `swagger-ui-dist` 靠 `require.resolve` + `readFile` 从 `node_modules` 读静态文件 —— 打包进 APK 后没有 `node_modules`。
- ASR/TTS/LLM 全部指向外部 HTTP 服务，手机本地没有。
- 网关 71 个 TS 文件、`static/cues/*.mp3`，目前按目录结构运行，需 bundle 成单文件。

### 2.4 端侧 ASR 的可行性与「能否装进手机」

| 方案 | Android | iOS | 评价 |
|---|---|---|---|
| Python whisper / 现有 9529 服务 | ❌ | ❌ | 只能留在服务器 |
| whisper.cpp（C++） | ✅ tiny/base | ✅ tiny/base + CoreML/ANE | 可行，但中文短句 WER 高、自回归慢、无原生流式 |
| **sherpa-onnx + SenseVoice** | ✅ int8 RTF≈0.06 | ✅ xcframework | **最合适**：中文 CER≈3%、非自回归一次出整句、带标点/ITN |

`app-product-wake` 唤醒插件已用 sherpa-onnx，同一个原生库再加 SenseVoice ASR + Silero VAD 即可把「唤醒 + 识别」都放端侧，不引入第二套 C++ 栈。

**能装进手机，已查证**：

- 官方仓库带 `android/`、`ios-swift/`、`ios-swiftui/`、`kotlin-api-examples/`，2026-08 重构了 macOS/iOS `xcframework` 构建，Apache-2.0 许可，2026-11 仍在活跃维护（含 iOS 崩溃修复）。
- 生产先例：中国联通、中国人寿 App 已用 sherpa-onnx Kotlin API 做 KWS 上线；EchoNote 用「Capacitor 壳 + 原生 sherpa-onnx JNI 插件」在 Android 上跑 SenseVoice，首启下载约 270MB 模型后**飞行模式可用**。
- 必须分清**引擎**与**模型**：
  - 引擎（`onnxruntime` + sherpa-onnx native lib / `.so` / xcframework）：编译进 APK/IPA，量级几 MB～几十 MB。
  - 模型（SenseVoice Small int8 ~240MB）：**不进安装包**，首启下载到 App 私有目录，之后完全离线随用随加载。否则包体过大、审核与更新都困难。
- iOS 侧注意事项：需 `audio` background mode 保活；模型下载用系统后台传输或前台显式进度；不可下发可执行代码（App Store 规则）。

### 2.5 AI 服务决策（已定）：ASR / TTS 双模式，LLM 单模式

**ASR 与 TTS 都要同时支持「端侧离线」与「服务端/云端 API」两种模式，运行时可切换**；不是二选一，而是两套都要有、按配置或网络状况选择。用户明确「TTS、ASR 都在支持离线吧」「但是 API 也可以支持」。

- 端侧：sherpa-onnx + SenseVoice（ASR）、Kokoro/Piper/VITS（TTS），模型首启下载、不进安装包，之后断网可用。
- API：现有网关 provider 抽象（外部 LAN `:9529` / Ollama，或 DashScope 等云端）直接复用。
- 切换策略建议：默认走 API（音色统一、延迟低）；**网络不可用时自动降级到端侧**，设置页可手动强制任一侧。断网时 LLM 不可用，助手需明确口播「网络不可用」而不是假装能回答。

**LLM 只有一种模式：服务端或云端 API，不做端侧**（手机算力与内存跑不动可用质量的 LLM）。即「听见 / 说话」可离线，「思考」必须联网。

**端侧 TTS 已评估可行**：sherpa-onnx 官方提供预编译 Android TTS APK，VoxSherpa TTS（Kokoro-82M / Piper / VITS，中文等 50+ 语言）是 100% 离线上线 App；iOS 需从源码构建 xcframework。两点代价需接受：① 端侧音色与网关 `edge` / XiaoxiaoNeural 不同，切换时要让用户有预期（或选 Piper 中文音色尽量接近）；② 非流式、延迟偏高 —— Kokoro-82M 旗舰机约 20–40 秒生成 1 分钟音频，中端 60–90 秒，Piper 旗舰约 5 秒/分钟音频。因此 **API 模式仍是默认**，端侧作为离线兜底。

### 2.6 平台版本支持与本机工具链（已查证）

| 项 | Android | iOS |
|---|---|---|
| 最低系统版本 | `minSdkVersion 21` = **Android 5.0+**（官方：「最低支持21，小于21在部分5.0以下机型上将无法正常使用」） | 官方文档**未明确** deployment target，需从离线 SDK 工程读 `IPHONEOS_DEPLOYMENT_TARGET` 确认，不猜 |
| 建议目标版本 | `targetSdkVersion 30+`；新工具链 `compileSdk 36` | 跟随 Xcode 26 SDK |
| CPU 架构 | `armeabi-v7a` / `arm64-v8a` / `x86` | arm64 真机 / 模拟器 |
| 工具链 | HBuilderX 4.81+ 起适配 16KB 页：`buildTools 36.0.0`、`Gradle 8.14.3`、`AGP 8.12.0`；**离线 SDK 不支持 Kotlin** | **Xcode 26.0+**（官方原文） |
| 硬要求 | 3.1.10+ 需 **AppKey**；`manifest.json` 的 `appid` 不能为空 | 同需 AppKey；**打包资源版本必须与离线 SDK 版本一致**，否则启动弹「版本不一致」提示 |
| 目标设备 | 荣耀 Magic4（骁龙 8 Gen 1 / arm64 / Android 12+）远满足 | iPad：型号与 iOS 版本待确认 |

**本机现状（2026-11-08 实测）**：macOS **15.7.4**（Sequoia）、Intel i7-8850H / 32GB RAM / **154Gi 可用磁盘**、`Xcode 16.4`（❌ 低于 26.0）、`Android Studio.app 未安装`（❌）、Android SDK 有 `android-35/36/Baklava` 与 `Pixel5_API35` AVD、`adb` 已装但 `adb devices` 为空、`xcrun simctl` 设备全 Shutdown。→ **iOS 侧当前编译不了；Android 侧需先装 Android Studio**。

**工具链安装/升级可行性（已查证）**：
- **Android Studio**：✅ 可装。官方 macOS 最低要求 `macOS 12`、8GB RAM、8GB 磁盘、Apple M1 或第 6 代 Intel Core 以上（本机 i7-8850H = 第 8 代，达标；官方注明「逐步停止支持 Intel Mac」，但目前仍可用）。Homebrew cask `android-studio` 版本 `2026.2.2.9`。
- **Xcode 16.4 → 26**：✅ 可升级且**无需升级 macOS**。Apple 官方原文「Xcode 26 requires a Mac running macOS Sequoia **15.6 or later**」，本机 15.7.4 达标；Xcode 26.1 支持 `Sequoia 15.6 – Tahoe 26.x`；设备调试最低支持 iOS 15+。途径：Mac App Store（需 Apple ID 登录）或 developer.apple.com 下载 `.xip`。**注意**：升级会替换现有 16.4，可能影响依赖旧版 Xcode 的其它工程；如需并存，可把 16.4 重命名为 `Xcode-16.4.app` 后再装 26，用 `xcode-select -s` 切换。
- **HBuilderX**：✅ 可装。Homebrew cask `hbuilderx` 版本 `5.34.2026102909`，**与 DCloud iOS 离线 SDK 最新正式版 `5.34.2026102909` 完全同版本**，正好满足 §2.6「打包资源版本必须与 SDK 一致」的硬要求。按 §2.7 只用一次做 appid + 资源导出，之后仍走离线工程。

> 决策变化：用户 2026-11-08 说「先不用 HBuilderX 吧」，随后改为「那 HBuilderX 也安装下吧」—— 即三个工具（Android Studio / Xcode / HBuilderX）都准备齐，但打包仍以离线 SDK 为主，HBuilderX 只承担最小必要的导出职责。

### 2.7 打包路径决策：先不用 HBuilderX（已定）

用户决定「先不用 HBuilderX 吧」，走 **DCloud App 离线打包 SDK + Android Studio / Xcode**。但官方《准备工作》有一条硬限制必须记录：

> 「通过 vue-cli 命令行创建的项目，**不可直接通过 cli 命令生成本地打包 App 资源**，需通过 HBuilderX 打开 cli 命令创建的项目，在 HBuilderX 可视化界面中操作导出。」

`npm run build:app` 虽已产出 `dist/build/app`，但当前 `manifest.json` 的 `appid` 为空字符串，离线工程 `dcloud_control.xml` 校验会失败。因此「完全不用 HBuilderX」在**导出资源这一步**仍有障碍，可选处置：

1. 用 HBuilderX 仅做一次「打开项目 → 获取 appid → 导出生成本地打包 App 资源」，之后全程 Android Studio / Xcode / adb，不再依赖它（**最小依赖路径，推荐**）。
2. 手工补齐 `appid`、按 SDK 版本对齐 `dcloud_control.xml`，直接把 `dist/build/app` 拷进 `assets/apps`（有版本一致性弹窗风险，需实测）。
3. 原生插件 `app-product-wake` 用离线 SDK 的 `UniPlugin-Hello-AS` 工程开发 aar / framework，手动集成，不走插件市场云打包。

## 3. 推荐架构

```
┌─────────────────────────── 同一个安装包 ───────────────────────────┐
│  App 主进程                                                          │
│   ├─ uni-app UI（Vue3）                                              │
│   ├─ AudioCapture / WakeProvider / PermissionStatus                  │
│   └─ WS client ──────────────┐                                      │
│                              │ ws://127.0.0.1:8787（回环，不出网）   │
│  ┌───────────────────────────▼──────────────────────────────────┐  │
│  │ 网关运行时                                                    │  │
│  │ Android: :gateway 独立进程（FGS, type=microphone）             │  │
│  │ iOS    : App 进程内 Node 后台线程（audio background mode）      │  │
│  │  nodejs-mobile / 单文件 bundle：HTTP :8787 + WS /ws + REST     │  │
│  └───────────────┬───────────────────────────┬──────────────────┘  │
│                  │                           │                      │
│         AI 服务（可切换）              本地资源                       │
│   外部 LAN / 云端 API               cues mp3 / 配置 / 数据            │
└────────────────────────────────────────────────────────────────────┘
```

- **Android 真双进程**：`AndroidManifest.xml` 声明 `<service android:name=".GatewayService" android:process=":gateway">`，在该 Service 里加载 `libnode.so`。两个进程之间只用回环 TCP/WS 通信，Binder 都不需要。
- **iOS 同进程**：Node 以线程形式在 App 进程内启动；必须声明 `audio` background mode 保活（我们本来就要持续采集麦克风）。
- **端口固定 `127.0.0.1:8787`**，只绑回环，不暴露到局域网。

## 4. AI 服务接入：ASR / TTS 双模式 + LLM 单模式

网关 `config.ts` 已有 `stub/openai/ollama/dashscope/deepseek` 等 provider 抽象，改造重点是把「能力来源」做成运行时可切换，而不是编译期写死。

| 模式 | ASR | TTS | LLM | 说明 |
|---|---|---|---|---|
| **API · 外部 LAN** | `192.168.1.100:9529/voide` | `192.168.1.100:9529` | Ollama `:11434` | 手机需与服务器同网；改 `BASE_URL` 即可 |
| **API · 云端** | DashScope / OpenAI 兼容 STT | DashScope / OpenAI 兼容 TTS | DashScope / DeepSeek | 手机联网即用；`asr/http.ts` 已有 multipart WAV 上传路径可复用 |
| **端侧离线** | sherpa-onnx SenseVoice | sherpa-onnx Kokoro / Piper / VITS | **无（必须联网）** | 断网兜底；模型首启下载（ASR ~240MB + TTS 数十 MB），不进安装包 |

切换策略：默认 API；网络不可用时 ASR/TTS 自动降级到端侧，设置页可手动强制任一侧。LLM 无端侧实现，断网时助手需明确口播「网络不可用」。

**密钥约束**：AGENTS.md 明确「不要提交密钥」。云端 API Key **不能写进安装包**，需运行时由设置页输入并走加密本地存储（现有 `core/crypto` + `core/config/storage` 已有能力）。

## 5. 网关改造清单（逐文件）

| # | 文件 | 改动 | 原因 |
|---|---|---|---|
| 1 | `package.json` | 加 `build:bundle`（esbuild 打成单个 ESM/CJS 文件，platform=node，bundle 所有依赖） | APK 里没有 `node_modules`；动态 `require` 必须改成静态字面量，否则接口 404 |
| 2 | `src/db/client.ts` | **替换 `node:sqlite`**：改为轻量文件存储适配器（JSON/append-only），保持 `AppDb`/`DataService` 接口不变 | nodejs-mobile Node 18 无 `node:sqlite` |
| 3 | `src/mapper/*` | 跟随 #2 调整；表数据量小（sessions / device_data / command_logs / user_memory），文件存储足够 | 同上 |
| 4 | `src/swaggerUi.ts` | 内嵌构建加 `DOCS_ENABLED=false` 时整段跳过；保留桌面版 | `swagger-ui-dist` 读不到 `node_modules` |
| 5 | `src/server.ts` | `listen` 只绑 `127.0.0.1`；`CUE_DIR` 改为 APK assets 解包后的私有目录 | 回环安全 + 资源路径 |
| 6 | `src/config.ts` | `port` 默认 8787 但允许 `GATEWAY_PORT`；新增 `GATEWAY_MODE=embedded\|external`；AI 服务来源运行时可切换 | 双进程/外部两种部署共用一套代码 |
| 7 | `src/service/*` | 检查所有 `process.cwd()` / 相对路径 / `readFile` 相对路径，改成基于 `GATEWAY_HOME` 绝对路径 | 移动端 cwd 是 `/`，不是脚本目录 |
| 8 | 新增 `src/embedded/entry.ts` | 移动端入口：初始化 → 起 HTTP/WS → 通过插件桥回调「ready」 | 供原生层等待就绪 |
| 9 | `static/cues/*.mp3` | 复制到 APK assets，首启解包到私有目录 | `/static/cues` 白名单端点要能读到 |

## 6. 原生插件接口扩展（`app-product-wake`）

当前 JS 侧已约定：`start/stop/onWake/onError`（唤醒）+ `startPcm/stopPcm/onPcmFrame/onPcmError`（PCM 采集）。**新增网关生命周期接口**：

```
startGateway({ home, entry, port }) -> void
stopGateway() -> void
onGatewayReady(cb) -> void       // 原生层 TCP 探测成功后回调，UI 才放行
onGatewayExit(cb) -> void        // 退出/崩溃通知，避免白屏
```

`startGateway` 在 Android 的 `:gateway` Service 内、iOS 的 App 进程后台线程内加载 bundle。

## 7. 生命周期与端口（最容易翻车的地方）

1. **防重复初始化**：Node 在一个进程内只能初始化一次，重复调用会触发 V8 assert 直接崩。原生层用 `@Volatile`/原子标志 + C++ 侧 `g_running` 双层保护。
2. **确定性关停**：`onDestroy` / 退出时显式 `stopGateway()`、打断 libuv 事件循环、等待 ~300ms 释放端口；不要只靠系统 kill。
3. **端口占用兜底**：用户划掉 App 重开时残留 Node 线程仍占 8787 → 启动前探测端口，占用则先清理；或每次用 `GATEWAY_PORT=0` 让系统分配随机端口，通过 `onGatewayReady` 把实际端口回传给客户端（**推荐**，彻底避开冲突）。
4. **ready 探测**：客户端/原生层用 TCP connect `127.0.0.1:<port>` 轮询（最多 ~10s），成功才允许 UI 建 WS；失败要给可见错误而不是无限白屏。
5. **iOS 保活**：`audio` background mode + 持续录音会话；退后台时不要 `process.exit()`。

## 8. 客户端改造清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `core/transport/webSocketTransport.ts` | `VITE_GATEWAY_WS_URL` 在 embedded 模式下改为 `ws://127.0.0.1:<port>`，端口由 `onGatewayReady` 注入；external 模式保持原样 |
| 2 | `core/transport/` | 新增 `gatewayBootstrap.ts`：等 `onGatewayReady` → 拿端口 → 再 `connect()` |
| 3 | `features/assistant/useAssistant.ts` | `enable()` 之前先 await 网关就绪；网关未就绪时显示 i18n 提示，不静默 |
| 4 | `pages/settings/` | 新增「AI 服务来源」切换（外部 LAN / 云端 API）+ 云端 Key 输入（加密存储） |
| 5 | `core/i18n/messages.ts` | 新增网关启动/就绪/失败文案（zh/en） |
| 6 | `AGENTS.md` / `contracts/README.md` | 补回环地址、随机端口、`onGatewayReady` 契约 |

## 9. 打包与首启流程

```
构建期：esbuild bundle 网关 → gateway.bundle.js
      把 bundle + cues mp3 + nodejs-mobile .so 放进原生插件 assets
安装期：DCloud App 离线 SDK 工程（Android Studio / Xcode，含 app-product-wake 原生实现）→ 本地产出 APK / IPA
首启：  ① 原生层启动网关运行时（Android 独立进程 / iOS 后台线程）
       ② 解包 assets 到私有目录
       ③ TCP 探测 ready，回传实际端口
       ④ 客户端注入 ws://127.0.0.1:<port>，建连
       ⑤ 若启用端侧离线：提示下载 ASR ~240MB + TTS 数十 MB 模型（不进安装包）；API 模式不下载
```

## 10. 真机验证（荣耀 Magic4 / iPad）与 Orca 能力边界

| 设备 | 路径（离线 SDK，不用 HBuilderX 云打包） | 当前状态 |
|---|---|---|
| 荣耀 Magic4 (Android) | 装 Android Studio → 离线 SDK `HBuilder-Integrate-AS` 工程 → 集成 `app-product-wake` aar → Gradle 出 APK → `adb install` → `adb logcat` 看 Node 启动 | `adb` 已装但 `adb devices` **为空**；**Android Studio 未安装** |
| iPad (iOS) | 升级 Xcode 到 26+ → 离线 SDK `HBuilder-Hello` 工程 → 开发者签名 → Xcode 运行到设备 | **Xcode 16.4 低于要求 26.0**；开发者账号未配置 |
| iOS Simulator | `xcrun simctl boot` 或 `orca emulator attach` | 有设备列表，全部 `Shutdown`；`orca emulator list` sessions 为空 |
| Android 模拟器 | `Pixel5_API35` AVD 存在，`orca emulator attach` | 未启动；需先装 Android Studio |

**当前硬阻塞（按用户决定「先不用 HBuilderX」后重排）**：
1. Android Studio 未安装（Android 侧编译 APK 必需）；
2. Xcode 16.4 < 26.0（iOS 侧编译必需）；
3. `app-product-wake` 原生工程（KWS + PCM + 网关生命周期）尚未实现；
4. `manifest.json` 的 `appid` 为空，且官方要求 CLI 项目导出本地打包资源需经 HBuilderX（见 §2.7，可只用它做一次导出）；
5. 手机未连上（`adb devices` 空）。

**Orca 能做什么**：`orca computer` 驱动 macOS 桌面窗口（截图/点击/键盘）—— 本轮已用它刷新 Chrome 里的 H5 页面并截图验证；`orca emulator attach` 可挂 iOS/Android 模拟器做 computer-use。

**Orca 不能做什么**：不能凭空把 uni-app App 装进模拟器/真机，也不能替代 Android Studio / Xcode 完成编译签名。必须先有离线工程产出的 APK/IPA。

## 11. 分阶段计划（建议）

| 阶段 | 交付 | 前置 |
|---|---|---|
| P0 | 装 Android Studio → 离线 SDK 工程跑通 → `app-product-wake` 原生插件（KWS + PCM + 网关生命周期）集成成 aar → APK 装到荣耀 Magic4 | Android Studio；`appid`（见 §2.7）；原生工程 |
| P1 | 网关 bundle 化 + 去掉 `node:sqlite`/swagger，桌面版 `npm start` 与 bundle 版行为一致（跑通现有 202 测试） | 无 |
| P2 | Android 双进程跑通：回环 WS、唤醒→识别→TTS 全链路，AI 服务走外部 LAN | P0 + P1 |
| P3 | AI 服务来源切换（外部 / 云端 API）+ Key 安全存储 | P2 |
| P4 | iOS 同进程适配 + `audio` background mode 保活，iPad 实测 | P2 |
| P5（可选） | 端侧离线 ASR + TTS（SenseVoice + Kokoro/Piper），模型首启下载；**LLM 仍走服务端/云端**，断网时 ASR/TTS 自动降级 | P2；工作量大 |

## 12. 风险与待决策

1. **nodejs-mobile 停更**：Node 18 已 EOL 且有未修漏洞，联网 App 有风险；Android 16KB 对齐未修。替代：自行编译较新 Node 的 mobile 分支，或把网关逻辑用 Kotlin/Swift 重写（工作量大）。**需决策**。
2. **iOS App Store 审核**：内嵌 JS 运行时执行**下载**的代码会被拒；只执行包内 bundle 的代码有先例（Manyverse、Mapeo 已上架）。不得做热更新下发 JS。
3. **包体与耗电**：`libnode.so` 各架构约 4.5MB；ASR ~240MB + TTS 数十 MB 模型必须首启下载；持续录音 + 端侧推理约 15–30%/小时耗电。
4. **云端 API Key** 分发与存储方案需单独确认（不能进包、不能进代码库）。
5. **「2 个进程」iOS 侧**：确认接受「同进程后台线程」这一退化，还是 iOS 先不做内嵌、继续连外部网关。
6. **工具链版本不满足**：Xcode 16.4 < 离线 SDK 要求的 26.0；Android Studio 未安装；离线 SDK 不支持 Kotlin；AppKey 与 `appid` 待申请/补齐。**需决策**：是否升级 Xcode / 装 Android Studio。
7. **「先不用 HBuilderX」与资源导出的冲突**（§2.7）：官方要求 CLI 项目导出本地打包资源需经 HBuilderX。**需决策**：接受「仅导出时用一次 HBuilderX」，还是手工对齐 `appid` 与 SDK 版本硬闯（有版本不一致弹窗风险）。
8. **端侧 TTS 音色与延迟**（§2.5）：与网关 `edge`/XiaoxiaoNeural 音色不统一、非流式延迟偏高。**需决策**：端侧作为离线兜底是否接受音质回退，或限定只用 Piper 中文音色。
