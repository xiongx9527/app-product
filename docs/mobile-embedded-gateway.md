# Node 网关与 App 同包（双进程）架构方案与改造清单

> 状态：**P1 已实施并验证（2026-11-09）**；**§12 Node fork 选型已由用户拍板定稿（见 §14）**；P0/P2+ 未实施。
> P1 交付：`gateway` 加 `npm run build:bundle`（esbuild 单文件 2.0MB `dist/gateway.bundle.mjs`），可脱离 `node_modules` 独立运行；桌面版↔bundle 版 HTTP/WS 行为一致（仅 `/docs` 按设计禁用）；244 测试全绿、tsc 零报错。详见 §13。
> §12 定稿：**两端都必须内嵌 Node.js**（用户明确否决 iOS 连外部网关）；**Android = iOS 统一用 digidem/nodejs-mobile v24.20.0（full，含 full-icu + node:sqlite）**——2026-11-09 末用户拍板两端统一，撤销原 Android=OpenFlun v22.23.2 选型（见 §12 #1 修订、#9 决议）。iOS 形态 = App 进程内后台线程（P4 必做，前置 Xcode 26 + digidem 的 iOS `NodeMobile.xcframework`）。详见 §14。
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

### 2.2 nodejs-mobile 的约束（2026-11-09 查证定稿）

1. **官方主线停更，社区 fork 接手**：`JaneaSystems/nodejs-mobile` README 明写「no longer being actively maintained」，最后 release v18.20.4（2024-10）、Node 18 已 2025-04 EOL；社区迁到 `github.com/nodejs-mobile` org。**但 org 的 releases 页最新仍是 v18.20.4**，Node 22/24 只是 main 分支的 commit（16KB #154），**没有发布产物**。真正提供预编译产物的是第三方 fork：**OpenFlun/nodejs-mobile v22.23.2**（仅 Android arm64/x86_64）、**digidem/nodejs-mobile v24.20.0**（**Android + iOS 双端、full/lite 双 flavour，CI 门禁 + 真机冒烟**，本项目最终选用）、TryQuiet/quiet 的 Node 24.22.1 自编译（draft PR、产物未签名未托管）。
2. **`node:sqlite` 门槛是 22.13，不是 22.5**：22.5–22.12 需 `--experimental-sqlite`；**22.13.0 / 23.4.0 / 24+ 才免 flag**（Node 官方 sqlite 文档 History）。OpenFlun = 22.23.2 → 免 flag ✓。Node 22 里它仍是 Stability 1.1（active development），24.15+ 才是 1.2 RC；**Node 版本钉死在 `.so` 里，API 不会在脚下变**，故可用。网关 `db/client.ts` + drizzle-orm/node-sqlite 依赖它 → **选 Node 22.13+ 就不必替换数据库**，§5 #2/#3 可省略。
3. **`intl` / full-icu 是硬约束（此前漏记）**：nodejs-mobile 默认 `--with-intl=none`，V8 解析 Unicode 属性转义会抛 `SyntaxError`。**网关在 13 处用了 `\p{...}`**（`asr/noiseFilter.ts`、`tts/sanitize.ts`、`service/music/*`、`types.ts`），一旦 intl=none，bundle 入口加载即失败。OpenFlun v22.23.2 专门改为 `--with-intl=full-icu`（其 `UPGRADE.md §4.6`，动机与本项目完全一致）→ **这条直接淘汰官方 v18 主线与社区 org 默认构建**。
4. **`child_process` / `cluster` / `intl`(默认) / V8 inspector 不支持**；`process.cwd()` 在移动端是 `/`（§5 #7 已处理）；`process.exit()` 在 iOS 会终止整个 App（App Store 禁止）；iOS 不支持 WebAssembly/JIT。**本网关不用 `child_process`**（全仓 grep 过），故该反对理由不适用。
5. **16KB 页对齐（2026-11-09 末 ELF 实测已闭环）**：TryQuiet 的 Node 24 自编译明确验证（`LDFLAGS=-Wl,-z,max-page-size=16384`）；**OpenFlun 未证实**。**digidem v24.20.0 Android 包已实测**：从 `nodejs-mobile-android-24.20.0-0.zip`（77677749 B、sha256 `f5ffbaf4...f37bb`）用 range 取三个 `libnode.so` 的 ELF program header，直接解析 PT_LOAD 的 `p_align`——**`bin/arm64-v8a`（ELF64）、`bin/x86_64`（ELF64）、`bin/armeabi-v7a`（ELF32）全部 `p_align=0x4000`(16384)，每个 4 个 PT_LOAD 段均对齐** ✅。即三 ABI 都是 16KB 对齐，上架 Android 15+ / Play 2027-02 强制无需重编。当前 `targetSdk 33` 本地/企业分发本就不触发该强制；升 35+/上架可直接使用。

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
| **API · 外部 LAN** | `192.168.1.100:9529/voice` | `192.168.1.100:9529` | Ollama `:11434` | 手机需与服务器同网；改 `BASE_URL` 即可 |
| **API · 云端** | DashScope / OpenAI 兼容 STT | DashScope / OpenAI 兼容 TTS | DashScope / DeepSeek | 手机联网即用；`asr/http.ts` 已有 multipart WAV 上传路径可复用 |
| **端侧离线** | sherpa-onnx SenseVoice | sherpa-onnx Kokoro / Piper / VITS | **无（必须联网）** | 断网兜底；模型首启下载（ASR ~240MB + TTS 数十 MB），不进安装包 |

切换策略：默认 API；网络不可用时 ASR/TTS 自动降级到端侧，设置页可手动强制任一侧。LLM 无端侧实现，断网时助手需明确口播「网络不可用」。

**密钥约束**：AGENTS.md 明确「不要提交密钥」。云端 API Key **不能写进安装包**，需运行时由设置页输入并走加密本地存储（现有 `core/crypto` + `core/config/storage` 已有能力）。

## 5. 网关改造清单（逐文件）

> **状态（2026-11-09 校正，2026-11-09 末统一）**：本清单原按「Node 18 无 `node:sqlite`」的旧假设写。§12 选型定为 **digidem/nodejs-mobile v24.20.0（full，22.13+ 免 flag、full-icu）** 后，**#2/#3 不必做、勿擅自改数据库**。P1 已完成 #1/#4/#5（见 §13）；#6/#7/#8/#9 属 P2/P4 原生层工作，未做。

| # | 文件 | 改动 | 原因 | 状态 |
|---|---|---|---|---|
| 1 | `package.json` | 加 `build:bundle`（esbuild 打成单个 ESM/CJS 文件，platform=node，bundle 所有依赖） | APK 里没有 `node_modules`；动态 `require` 必须改成静态字面量，否则接口 404 | ✅ P1 已做 |
| 2 | `src/db/client.ts` | ~~替换 `node:sqlite` 为文件存储适配器~~ | 原因为「Node 18 无 `node:sqlite`」，选型更正后不成立 | ❌ **不必做**（Node 22.13+ 免 flag）；仅当被迫用 Node 18 才需要 |
| 3 | `src/mapper/*` | ~~跟随 #2 调整~~ | 同上 | ❌ **不必做** |
| 4 | `src/swaggerUi.ts` | 内嵌构建加 `DOCS_ENABLED=false` 时整段跳过；保留桌面版 | `swagger-ui-dist` 读不到 `node_modules` | ✅ P1 已做（改为延迟解析 + 解析失败降级） |
| 5 | `src/server.ts` | `listen` 只绑 `127.0.0.1`；`CUE_DIR` 改为 APK assets 解包后的私有目录 | 回环安全 + 资源路径 | ✅ P1 已做（`GATEWAY_MODE=embedded` / `GATEWAY_HOME`） |
| 6 | `src/config.ts` | `port` 默认 8787 但允许 `GATEWAY_PORT`；新增 `GATEWAY_MODE=embedded\|external`；AI 服务来源运行时可切换 | 双进程/外部两种部署共用一套代码 | ⬜ P2（只读 env，未改 config 接口） |
| 7 | `src/service/*` | 检查所有 `process.cwd()` / 相对路径 / `readFile` 相对路径，改成基于 `GATEWAY_HOME` 绝对路径 | 移动端 cwd 是 `/`，不是脚本目录 | ⬜ P2（清查过，仅 `server.ts` 与 `swaggerUi.ts` 有文件读取，已在 P1 处理） |
| 8 | 新增 `src/embedded/entry.ts` | 移动端入口：初始化 → 起 HTTP/WS → 通过插件桥回调「ready」 | 供原生层等待就绪 | ⬜ P2 |
| 9 | `static/cues/*.mp3` | 复制到 APK assets，首启解包到私有目录 | `/static/cues` 白名单端点要能读到 | ⬜ P2（需原生层配合） |

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
| 荣耀 Magic4 (Android) | 离线 SDK `HBuilder-Integrate-AS` 工程 → 集成 `app-product-wake` aar → Gradle 出 APK → `adb install` → `adb logcat` 看 Node 启动 | Android Studio ✅已装；**真机未连**（`adb devices` 只有模拟器） |
| iPad (iOS) | 升级 Xcode 到 26+ → 离线 SDK `HBuilder-Hello` 工程 → 开发者签名 → Xcode 运行到设备 | **Xcode 26.3 已装**（见 §14 B2，2026-11-09 完成）；**iOS Node 运行时已有预编译产物**（digidem/nodejs-mobile fork，Node 24 full，见 §14 B1 解除）；开发者账号/签名/真机未配置 |
| iOS Simulator | `xcrun simctl boot` 或 `orca emulator attach` | 有设备列表，全部 `Shutdown`；`orca emulator list` sessions 为空 |
| Android 模拟器 | `Pixel5_API35` AVD 存在，`orca emulator attach` | ✅ 已启动（`emulator-5554`，可装包）；2026-11-09 已实测离线 APK 能装能起 Activity |

**当前硬阻塞（2026-11-09 校正，2026-11-09 末更新，详见 §14）**：
1. ~~Xcode 16.4 < 26.0~~ → **已解除**：Xcode 26.3 已装（唯一实例 `/Applications/Xcode.app`），iOS 侧编译就绪。
2. ~~没有 Node 22+ full-icu 的 iOS 运行时产物~~ → **已解除**：digidem/nodejs-mobile fork 提供 **Node 24.20.0 的 `NodeMobile.xcframework`（full flavour，含 full-icu + node:sqlite）** 现成预编译产物，无需自编（见 §14 B1）。
3. `app-product-wake` 原生工程（KWS + PCM + 网关生命周期）尚未实现；
4. `manifest.json` 的 `appid` 为空 + AppKey 未申请（装到设备能启动运行的必需条件，实测已复现校验失败弹窗）；
5. 真机未连（当前 `adb devices` 仅 `emulator-5554`）；开发者签名/iPad 未就绪。
6. **iOS 模拟器调试限制（新增，2026-11-09 末）**：digidem 的 iOS 包仅含 `arm64` 真机 + `arm64` 模拟器切片，**无 `x86_64` 模拟器切片**。本机是 Intel Mac，Xcode 模拟器跑 x86_64 → 无法在本机模拟器加载该 xcframework，iOS 网关联调只能走**真机（arm64 iPad）**或换 Apple Silicon Mac。

**Orca 能做什么**：`orca computer` 驱动 macOS 桌面窗口（截图/点击/键盘）—— 本轮已用它刷新 Chrome 里的 H5 页面并截图验证；`orca emulator attach` 可挂 iOS/Android 模拟器做 computer-use。

**Orca 不能做什么**：不能凭空把 uni-app App 装进模拟器/真机，也不能替代 Android Studio / Xcode 完成编译签名。必须先有离线工程产出的 APK/IPA。

## 11. 分阶段计划（建议）

| 阶段 | 交付 | 前置 |
|---|---|---|
| P0 | 装 Android Studio → 离线 SDK 工程跑通 → `app-product-wake` 原生插件（KWS + PCM + 网关生命周期）集成成 aar → APK 装到荣耀 Magic4 | Android Studio（✅已装）；`appid`（见 §2.7）；原生工程 |
| **P1** ✅ | **网关 bundle 化（已实施并验证，见 §13）**：esbuild 单文件、脱离 `node_modules` 独立运行、桌面↔bundle 行为一致、244 测试全绿。**未去掉 `node:sqlite`**（选型定为 Node 22.13+ fork 后不必改） | 无（已完成） |
| P2 | Android 双进程跑通：接入 **digidem v24.20.0** `libnode.so`（arm64-v8a + armeabi-v7a + x86_64，16KB 对齐）→ 回环 WS、唤醒→识别→TTS 全链路，AI 服务走外部 LAN | P0 + P1 + **§12 #1 选型定稿（digidem v24.20.0）** |
| P3 | AI 服务来源切换（外部 / 云端 API）+ Key 安全存储 | P2 |
| **P4** ⬆️必做 | **iOS 内嵌网关**（用户定：Node 必须内嵌，不许退化连外部网关）：**digidem v24.20.0 的 `NodeMobile.xcframework`（full）** → App 进程内后台线程 + `audio` background mode → iPad 实测 | **升 Xcode 26（已完成）+ 引入 digidem iOS full 包（已实现，见 §14 B1）**；详见 §14 |
| P5（可选） | 端侧离线 ASR + TTS（SenseVoice + Kokoro/Piper），模型首启下载；**LLM 仍走服务端/云端**，断网时 ASR/TTS 自动降级 | P2；工作量大 |

## 12. 风险与待决策

1. **nodejs-mobile 实现选型（2026-11-09 初定 OpenFlun v22.23.2；2026-11-09 末用户拍板统一修订）**：**两端统一 = digidem/nodejs-mobile v24.20.0（full，含 full-icu + node:sqlite + inspector + TS 类型剥离）**。Android 取 `android` 包（arm64-v8a + armeabi-v7a + x86_64、**2026-11-09 末 ELF 实测 16KB 对齐**，见 §2 #5），iOS 取 `ios` 包（`NodeMobile.xcframework`：arm64 真机 + arm64 模拟器，无 x86_64 模拟器切片）。理由：与 iOS 必须用的 digidem 一致，**单一运行时**消除两端 Node 大版本分叉；同时一次性满足「现成预编译产物 + `node:sqlite` 免 flag（22.13+/24 均满足）+ full-icu（`\p{...}`）」三项硬条件，且额外把 OpenFlun 遗留的 **16KB 未证实** 风险坐实为**已对齐**（三 ABI `p_align=0x4000`）并补 32 位（armeabi-v7a）覆盖。P1 bundle 零改动直接跑（引擎无关 ESM），不必改数据库、不会因正则崩溃。**接受的风险**：① digidem 是 recipe 式维护（CI 门禁 + 真机冒烟，较活跃），但同样需长期跟踪 CVE；② iOS 包**无 x86_64 模拟器切片**，本机 Intel Mac 无法在模拟器加载，iOS 联调只能真机（arm64 iPad）或 Apple Silicon Mac（见 §10 #6）；③ Node 24 较新，但 2025-10 起已是 LTS，且运行时版本钉死在产物内、API 不会在脚下变。拿到 `.so`/`.xcframework` 后第一件事实测 `require('node:sqlite')` 与 `\p{...}` 正则，任一不过则回退 §5 #2/#3 文件存储适配器。**撤销的原选型**：OpenFlun v22.23.2（仅 Android、16KB 未证实），其前提是「唯一满足三项硬条件」，现因 digidem 同样满足且更优而被取代。
2. **iOS App Store 审核**：内嵌 JS 运行时执行**下载**的代码会被拒；只执行包内 bundle 的代码有先例（Manyverse、Mapeo 已上架）。不得做热更新下发 JS。
3. **包体与耗电**：`libnode.so` 各架构约 4.5MB；ASR ~240MB + TTS 数十 MB 模型必须首启下载；持续录音 + 端侧推理约 15–30%/小时耗电。
4. **云端 API Key** 分发与存储方案需单独确认（不能进包、不能进代码库）。
5. **「2 个进程」iOS 侧（2026-11-09 用户拍板）**：接受「同进程后台线程」退化；**且明确 Node.js 必须内嵌，iOS 不许退化成连外部网关**（用户原话「nodejs 是必须内嵌的」）。→ 两端都必须内嵌，iOS 只接受「App 进程内 Node 后台线程 + `audio` background mode」这一种形态。因此 **§11 P4 从「可选适配」升为必做**，具体阻塞与排期见 §14。
6. **工具链版本不满足（2026-11-09 现状校正）**：**Xcode 16.4 < 26.0**（iOS 侧编译必需）；Android Studio **已安装**（旧记忆误记未装）；离线 SDK 不支持 Kotlin；AppKey 与 `appid` 待申请/补齐。**Xcode 26 升级路径已查证可行**（§2.6：macOS 15.7.4 达标，可与 16.4 并存用 `xcode-select -s` 切换）。因 iOS 必须内嵌（见第 5 条），**升 Xcode 26 升为 P0 级前置，不再是可选**。
7. **「先不用 HBuilderX」与资源导出的冲突**（§2.7）：官方要求 CLI 项目导出本地打包资源需经 HBuilderX。**需决策**：接受「仅导出时用一次 HBuilderX」，还是手工对齐 `appid` 与 SDK 版本硬闯（有版本不一致弹窗风险）。
8. **端侧 TTS 音色与延迟**（§2.5）：与网关 `edge`/XiaoxiaoNeural 音色不统一、非流式延迟偏高。**需决策**：端侧作为离线兜底是否接受音质回退，或限定只用 Piper 中文音色。
9. **两端 Node 大版本不一致（2026-11-09 末，已决议）**：原 §12 #1 定 Android=OpenFlun v22.23.2，与 iOS 必用的 digidem Node 24 分叉。经运行时权衡（16KB 对齐、单一运行时、32 位覆盖、维护面），**用户拍板选 (a) 统一到 digidem Node 24.20.0**，Android 也改用 digidem 的 `android` 包。§12 #1 已据此修订，本条目闭环。

## 13. P1 实施记录（2026-11-09，已验证）

**改动（`xiaoxiong-app/gateway`，3 文件 30 行）**
- `package.json`：加 `build:bundle`（esbuild 单文件 ESM，2.0MB `dist/gateway.bundle.mjs`）与 `esbuild@0.28.2` 显式依赖。
  - **关键坑**：ESM bundle 里 CJS 依赖（dotenv）的 `require('fs')` 会触发 esbuild「Dynamic require not supported」→ 必须用 `--banner:js` 注入 `createRequire`。
  - `swagger-ui-dist` 保持 external（离线包没有 `node_modules`）。
- `src/swaggerUi.ts`：`require.resolve('swagger-ui-dist/package.json')` 由模块顶层改为延迟解析；解析失败或 `DOCS_ENABLED=false` 时禁用 `/docs`，其余接口不受影响。
- `src/server.ts`：`CUE_DIR` 支持 `GATEWAY_HOME`（APK 内 bundle 在 assets，`import.meta.url` 相对路径会指错）；`GATEWAY_MODE=embedded` 时 `listen` 只绑 `127.0.0.1`。桌面默认行为不变。

**验收（全绿）**
- `npm run type-check` 零报错；`npm test` 20 文件 / 244 用例全过。
- `npm run build:bundle` 产出 2.0MB 单文件，复制到**无 `node_modules` 的临时目录**后 `node gateway.bundle.mjs` 独立启动成功。
- 桌面版（tsx 源码）↔ bundle 版逐一比对 9 个 HTTP 端点：除 `/docs`（按设计禁用）外全部 SAME；WS `session.start` 握手 → 收到 `client.cue` 事件，链路通。

**未做（含理由）**
- 不替换 `node:sqlite`：§2.2 定稿后选型为 Node 22.13+ fork，内置且免 flag，无需文件存储适配器；**未擅自改数据库**。
- P0（`app-product-wake` aar、appid）与 P2+（原生层加载 bundle、`onGatewayReady`、双进程/同进程保活）未动。

**给 P2 的接入约定**：把 `gateway.bundle.mjs` + `static/cues/*.mp3` 放进 APK assets，首启解包到私有目录，注入 `GATEWAY_HOME=<私有目录>`、`GATEWAY_MODE=embedded`、`DOCS_ENABLED=false`；`GATEWAY_PORT=0` 让系统分端口（§7 推荐），经 `onGatewayReady` 回传实际端口给客户端。bundle 入口仍是 `server.ts` 的 `if (import.meta.url === file://argv[1])` 自启动判断，P2 视需要另加 `src/embedded/entry.ts`（§5 #8）。

## 14. §12 选型定稿与 iOS 内嵌排期（2026-11-09 用户拍板）

**决策（已锁定，不再是待决策）**
1. **两端都必须内嵌 Node.js 网关**。用户原话「nodejs 是必须内嵌的」，明确否决「iOS 先连外部网关」的退化方案。
2. **Android 运行时 = digidem/nodejs-mobile v24.20.0**（full，`android` 包：arm64-v8a + armeabi-v7a + x86_64，16KB 页对齐，full-icu + node:sqlite）。见 §12 #1（已统一修订）。
3. **iOS 形态 = App 进程内 Node 后台线程 + `audio` background mode**（iOS 不允许 spawn 第二进程，§2.1）；不退化连外部网关。
4. **不修改网关数据库**（`node:sqlite` 在 22.13+ 免 flag），P1 bundle 零改动复用。

**iOS 内嵌当前硬阻塞（必须如实记录，不能假装能立刻开工）**
| # | 阻塞 | 现状 | 解除条件 |
|---|---|---|---|
| B1 | **没有 Node 22+ 的 iOS 运行时产物** | **已解除（2026-11-09 末）**：digidem/nodejs-mobile fork 发布 **Node 24.20.0 的 `NodeMobile.xcframework`（full flavour）** 现成预编译产物，含 full-icu + node:sqlite + inspector + TS 类型剥离；切片为 `ios-arm64`（真机）+ `ios-arm64-simulator`（模拟器），**无 `x86_64` 模拟器切片**（见 §10 #6）。已据包内中央目录、fork README 与**二进制符号硬验证**（2026-11-09 末）三重确认：完整包 39273752 字节、`zip -t` OK，`ios-arm64/NodeMobile.framework/NodeMobile`（Mach-O arm64）内含 `icudt78l/*` ICU 数据（含 `General_Category` 等 → `\p{...}`/`Intl` 可用）与 `node::sqlite::DatabaseSync::*` 符号，确认 full 满足网关两项硬依赖。→ **不再需要自编译 Node 22.23.2 + full-icu 的 xcframework**（原定 P4-a 最大未知项已消除） | 用 digidem 的 **full** 包（lite 会 drop ICU/node:sqlite，网关必崩）；注意网关 bundle 需在 Node 24 跑通（V8 13.6，基本兼容） |
| B2 | **Xcode 16.4 < 26.0** | **已解除（2026-11-09）**：Xcode 26.3 (17C529) 已装，唯一实例 `/Applications/Xcode.app`，许可已接受，`xcode-select -p` 指向它，iOS 26.2 SDK + 模拟器 runtime 就绪 | 无需再操作（详见底部「Xcode 26 升级」段，16.4 已删、xip 已删） |
| B3 | iOS 离线工程 | HBuilder-Hello 工程、开发者签名、iPad 真机、AppKey/appid 均未就绪 | 与 P0 同批补齐 |
| B4 | App Store 审核 | 内嵌 JS 运行时执行**下载**代码会被拒；只执行包内 bundle 有先例 | 只跑包内 `gateway.bundle.mjs`，**不得做热更新下发 JS**（§12 #2） |

**iOS 排期（P4，前置链）**
```
P0(iOS) 升 Xcode 26 + 备齐 iOS 离线 SDK 工程/签名/appid      ← 现在就能起手，不依赖 B1
   ↓
P4-a  引入 digidem/nodejs-mobile 的 **NodeMobile.xcframework（full, Node 24.20.0）**   ← 可行性已验证 ✅（见 B1）
       （不再自编译：fork 已发布现成预编译产物，含 full-icu + node:sqlite；网关须用 full 而非 lite）
       ✅ 版本已统一：Android 与 iOS 均用 **digidem/nodejs-mobile v24.20.0（full）**（见 §12 #1 修订、#9 决议）；单一运行时，无分叉
   ↓
P4-b  原生层加载 libnode/NodeMobile：App 进程内后台线程起网关 bundle
       注入 GATEWAY_HOME / GATEWAY_MODE=embedded / DOCS_ENABLED=false
   ↓
P4-c  audio background mode 保活 + onGatewayReady 回传端口（§7）
       客户端 core/transport 走回环 ws://127.0.0.1:<port>（§8）
   ↓
P4-d  iPad 真机端到端实测（唤醒→识别→TTS）
```

**能立刻起手的**：B2（升 Xcode 26，已完成）、B1（iOS Node 运行时，已找到现成预编译 full 产物，可行性已确认 ✅）——这两项原是不阻塞的前置；其余（B3 离线工程/签名、P4-b/c/d 原生加载与联调）按 P0→P4 链推进，需 appid/设备/签名。**P4-a 不再是未知项**，落地方式为「引入 digidem full 包」而非「自编译」。**两端已统一到 digidem Node 24.20.0**（见 §12 #1 修订、#9 决议），不再有版本分叉待决策。

### Xcode 26 升级调研与执行结果（2026-11-09 子 agent 调研 + 当日完成）

> **状态：已完成（2026-11-09）**。Xcode 26.3 (17C529) 已装为唯一实例 `/Applications/Xcode.app`，许可已接受，iOS 26.2 SDK + 模拟器 runtime 就绪，`xcode-select -p` 指向它。16.4 与 xip 安装包均已删除。下面保留调研细节备查。

**版本上限**：本机 macOS 15.7.4（Sequoia）最高可装 **Xcode 26.3**（build 17C529，2026-02-26），满足 DCloud「26.0+」。26.4 / 26.4.1 / 26.5 / 26.6 需 Tahoe 26.2+、Xcode 27.x 需 Tahoe 26.6+，本机装不了。Intel i7 选 **Universal** 包（网传「Xcode 26 需 M 芯片」不实，Apple 仅 visionOS 开发强制 M 芯片）。备选 26.2 / 26.1.1 / 26.0.1 均支持 15.6+。

**渠道与阻塞（已实测，非推测）**：
- 官方 `.xip`：`https://developer.apple.com/download/`（旧版在 `/download/more/`），**须 Apple ID 浏览器交互登录**（免费 ID 即可，无需付费会员）。直链 `curl -I https://download.developer.apple.com/Developer_Tools/Xcode_26.3/Xcode_26.3.xip` → `HTTP/2 302` → `location: /unauthorized/`，证明**纯 CLI 无交互无法取包**。
- **App Store 路线作废**：`mas info 497799835` 显示现供 **Xcode 27.2 / 最低 macOS 26.6**，本机装不了；且 App Store 版固定覆盖 `/Applications/Xcode.app`，**与「并存 16.4」冲突**。（`brew install mas` 已完成，可逆 `brew uninstall mas`；`mas account` 未登录。）
- 本机全盘无现成 `.xip` / Xcode 26 安装包；**16.4 与 `xcode-select -p` 全程未改动**，未执行 sudo / 删除 / 任何项目文件写入。

**用户已亲自完成（2026-11-09）**：① 浏览器登录 developer.apple.com/download，下 **Xcode 26.3 Universal** 的 `.xip` 到 `~/Downloads`；② `xip --expand` 解压、`mv` 为 `/Applications/Xcode.app`、删 16.4、删 xip；③ `sudo xcodebuild -license accept` 接受许可。已验证 `xcodebuild -version` → 26.3 (17C529)，`xcrun --sdk iphoneos --show-sdk-version` → 26.2，模拟器 runtime (iOS 26.1) 可用。

**并存安装命令（16.4 与 xcode-select 全程不变、每步可逆）**：
```
cd ~/Downloads
xip --expand Xcode_26.3.xip              # 就地解出 Xcode.app，需 ~40GB 空闲
mv Xcode.app Xcode-26.3.app              # 先改名，避免与 16.4 同名
mv Xcode-26.3.app /Applications/         # 不覆盖 /Applications/Xcode.app
open -a /Applications/Xcode-26.3.app     # 首次启动：Agree + 装组件
export DEVELOPER_DIR=/Applications/Xcode-26.3.app/Contents/Developer
xcodebuild -version                      # 应显 26.3
```
回退：`rm -rf /Applications/Xcode-26.3.app`，16.4 与 xcode-select 不受影响。**用 `DEVELOPER_DIR` 打包 DCloud iOS 工程无需 sudo、不改系统默认**；仅当要全局切换才需用户确认后 `sudo xcode-select -s /Applications/Xcode-26.3.app/Contents/Developer`（切回指回 `/Applications/Xcode.app/Contents/Developer`）。

> 下载完成后，用同一子 agent（已加载上下文）继续做并存解压 + `xcodebuild -version` 验证即可，无需重新调研。

## 15. 原生层加载骨架（P2 / P4 实施，2026-11-09 末）

**目标**：原生层加载 digidem/nodejs-mobile v24.20.0（full）运行时，在其内启动 `gateway.bundle.mjs`，两端统一。已产出骨架文件（详见 `xiaoxiong-app/native/README.md`），并端到端冒烟验证端口回写机制。

**网关侧改动（gateway）**
- 新增 `src/embedded/entry.ts`：**单一入口**。起网关 → 监听 `listening` → 把实际端口写回 `GATEWAY_PORT_FILE`（仅 `GATEWAY_MODE=embedded` 时写，桌面不落 stray 文件）。
- `src/server.ts`：删除原「直接运行自启动块」，改为只导出能力；自启动统一走 `entry.ts`（避免 bundle 内双入口）。
- `package.json`：`build:bundle` 与 `dev`/`start` 均指向 `entry.ts`。
- `src/config.ts`：端口读取新增 `GATEWAY_PORT`（内嵌原生层指定，0=系统分配），向后兼容 `PORT` 与默认 8787。
- 验收：`tsc` 零报错、244 测试全绿、`build:bundle` 出 2.0MB 单文件；**冒烟**：`GATEWAY_MODE=embedded GATEWAY_PORT=0` 跑 bundle → 端口文件生成且为动态端口（实测 56423）、`/api/health` 正常。

**原生侧骨架（xiaoxiong-app/native/）**
- `android/GatewayNodeService.java`：`:gateway` 独立进程 Service；首启把 `assets/gateway/` 的 bundle+cues 拷到 `no_backup`；调 JNI 桥；轮询端口文件广播。
- `android/gateway_node_bridge.cpp` + `CMakeLists.txt`：JNI 桥，启动前 `setenv`（TMPDIR/HOME/GATEWAY_*/NODE_*）后 `node::Start`（后台 `std::thread`，避免卡 Service）。
- `ios/GatewayNode.swift`：后台队列调 `node_start(argc, argv)`（digidem 头确认签名），启动前 setenv，轮询端口。
- 启动契约、环境变量清单、argv、端口回传协议、资产布局、两端工程接入步骤、已知风险/TODO，全部写入 `native/README.md`。

**打包脚本已接线（2026-11-09 末）**：`uni_app/scripts/package-android-offline.mjs` 新增 `--node-lib` / `--gateway-bundle` / `--gateway-cues` / `--no-gateway`；在原 4 步资源接入后新增两步：
- 步骤 5：`gateway.bundle.mjs` → `assets/gateway/gateway.bundle.mjs`，`static/cues/*.mp3` → `assets/gateway/static/cues/`（对应 `CUE_DIR`）；整目录由脚本管理、每次重建前清空（幂等）。
- 步骤 6：递归找 `--node-lib` 下所有 `libnode.so`，按父目录名判 ABI（白名单 arm64-v8a/armeabi-v7a/x86_64/x86/armeabi），拷进 `src/main/jniLibs/<abi>/`；只覆盖 `libnode.so`、不动工程其它 `.so`，非标准 ABI 目录跳过并告警。
- 同步把 `GatewayNodeService.extractAssets` 改为**递归**（原版只拷顶层文件，会漏掉 `static/cues/` 子目录里的提示音）。
- 验证：mock SDK 端到端跑通（manifest.id / control.xml / AppKey / bundle / 5 cues / 3 ABI libnode.so 全部到位），二次运行幂等、AppKey 正确复用替换、非标准 ABI 未误拷；`node --check` 语法通过。

**B1 二进制硬验证完成（2026-11-09 末）**：完整 iOS full 包 39273752 字节、`zip -t` OK；`ios-arm64/NodeMobile.framework/NodeMobile`（Mach-O arm64）内含 `icudt78l/*` ICU 数据（`General_Category` 等 Unicode 属性表）与 `node::sqlite::DatabaseSync::*` 符号，确认 full 满足网关 `\p{...}`/`Intl` 与 `node:sqlite` 两项硬依赖，lite 不可用。§14 B1 已同步。

**原生层已落位真实工程（2026-11-10，Android）**：`GatewayNodeService.java`（修 `java.nio.file`→`java.io` 兼容 minSdk21、先 loadLibrary("node")）、`gateway_node_bridge.cpp` + 自包含 `CMakeLists.txt`（按 `ANDROID_ABI` 选 `jniLibs/<abi>/libnode.so`、IMPORTED target）、`include/node/` 头（132 个）全部落入 `simpleDemo/src/main/`；`AndroidManifest.xml` 声明 `:gateway` Service（未碰 appkey）；`build.gradle` 加**条件式** `externalNativeBuild`——检测 SDK 装了 NDK+CMake 才启用，否则跳过保证 APK 可编译。`gradlew :simpleDemo:assembleDebug --offline` → **BUILD SUCCESSFUL**，127M APK 内含 3 ABI `libnode.so` + `gateway.bundle.mjs` + 5 cues。本机未装 NDK/CMake → JNI 桥 `libgatewaynode.so` 尚未编译（`sdkmanager "ndk;27.0.12077973" "cmake;3.22.1"` 后自动生效）。详见 `native/README.md`。

**状态**：Android 资产/运行库/Java/Manifest/条件式接线已落位且真实编译通过（未实机验证、网关 Service 尚无启动点）；iOS 侧仍骨架级。**P4-b/c 解锁条件**：appid + 开发者签名 + iPad 真机（iOS 模拟器无 x86_64 切片，见 §10 #6）；Android 还需 NDK 编 `libgatewaynode.so`、接 `startService` 启动点与端口注入；iOS 需另行获取 `HBuilder-Hello` 工程。

**digidem Android 包下载 + 16KB 对齐实测（2026-11-09 末）**：`nodejs-mobile-android-24.20.0-0.zip`（77677749 B，GitHub release digest `sha256:f5ffbaf4...f37bb`）。包结构 `bin/<abi>/libnode.so`（父目录名即 ABI，印证打包脚本步骤 6 的判 ABI 逻辑）+ `include/node/` 头。因 GitHub CDN 单连接限速 ~19KB/s，改用**中央目录 + range 只取压缩流前缀 + zlib 流式解压**直接读三个 `libnode.so` 的 ELF program header（无需下完整包即可验证）：
| ABI | ELF | PT_LOAD `p_align` | 16KB |
|---|---|---|---|
| `bin/arm64-v8a/libnode.so` | ELF64 | 4×`0x4000` | ✅ |
| `bin/x86_64/libnode.so` | ELF64 | 4×`0x4000` | ✅ |
| `bin/armeabi-v7a/libnode.so` | ELF32 | 4×`0x4000` | ✅ |

→ 三 ABI 全部 16KB 对齐，§2 #5 与 §12 #1 的「16KB 未证实」风险**实测闭环**，升 targetSdk 35+/上架无需自编重编。完整包另以 8 段并发下载供 `--node-lib` 实际接入（sha256/`zip -t` 校验）。
