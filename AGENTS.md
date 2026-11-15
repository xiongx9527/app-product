# AGENTS.md

给在本仓库工作的 AI Agent / 协作者的约定。读代码前先读这里。

## 项目是什么

语音助手客户端。一套 uni-app（Vue3 + TypeScript + Vite）代码，目标端**只有 Android / iOS App（自定义基座 + 原生插件）**。

主链路：**本地唤醒「小熊小熊」→ 本地招呼「我在」→ 语音对话 → T1 静默提示 → T2 退出本轮 → 回到待唤醒**。

H5 **仅开发阶段调试用**（当前在 `:5173` 上验证 UI 与链路），保留可编译与最小降级即可。微信小程序与 HarmonyOS **确定不支持**，不要为它们增加分支或降级逻辑。

## 常用命令

```bash
cd xiaoxiong-app/uni_app
npm run test        # vitest，必须全绿
npm run type-check  # vue-tsc，必须零报错
npm run dev:app     # App，需要 HBuilderX / 自定义基座
npm run dev:app-harmony
```

提交前至少跑 `test` + `type-check`。不要在没跑的情况下声称“已完成/已通过”。

## 目录与依赖方向

```
xiaoxiong-app/uni_app/src/
├── core/            # 与业务无关，禁止依赖 features / pages
│   ├── assistant/   # 纯状态机 + 单测
│   ├── audio/       # 本地提示音、后续采集与播放
│   ├── config/      # 配置类型、厂商模板、本地存储、连接测试
│   ├── database/    # SQLite 抽象（App: plus.sqlite）
│   ├── transport/   # Mock / WebSocket 客户端
│   ├── wake/        # 唤醒 provider（H5 / 原生 / 不支持）
│   └── adaptation/  # 断点、安全区
├── features/        # 业务编排，可以依赖 core
├── pages/           # 路由页面，只做展示与事件转发
└── static/          # 本地资源
```

- `core` 不依赖 `features`，`features/*` 之间不互相依赖。
- 状态机保持纯函数：输入旧状态 + 事件，输出新状态 + effects，副作用留在 `useAssistant`。
- 新增业务复用 `core`，不要复制状态机、配置、存储代码。

## 硬性约定

### 条件编译

- uni-app 的 `APP-PLUS` 命中 Android / iOS，即本项目的目标端；鸿蒙与小程序确定不支持，不写它们的条件编译分支。
- 条件编译只影响构建产物，**不要依赖预处理来消除 import**。provider 的导入在函数内做能力保护。
- 新增平台能力时，先判断 `isSupported()`，再决定是否降级，禁止直接抛到 UI。

### App 逻辑层的 JS 引擎能力

- App 端逻辑层（`app-service.js`）跑在**独立 JS 引擎**里，不是浏览器内核，对 Web API 的支持与 H5 不一致。**H5 正常不代表 App 正常**：同一段代码在 H5（浏览器内核）没问题、在 App 逻辑层可能直接抛错。
- 已实测：`new URLSearchParams(...)` 在 App 逻辑层抛异常。拼 URL 查询串一律用 `encodeURIComponent` + 字符串拼接，**不要用 `URLSearchParams`**、不要依赖其它未被确认的 Web API。
- 请求前的参数构造要放进 `try`；在 `try` 外抛错会让 `catch` 兜不住、函数静默中断、状态停在初始值（曾导致设置页四个下拉 forever `disabled`，而请求根本没发出去）。任何异步 load 都要让失败分支自己也给出可用状态，而不是让数组停在 `[]`。
- 排查「App 有、H5 没有」或「界面停在初始态」这类问题时，先怀疑逻辑层 API 差异，别急着归咎于旧代码/缓存。可 CDP 直连真机 WebView 验证：`adb forward tcp:9222 localabstract:webview_devtools_remote_<主进程PID>`，用 `curl http://127.0.0.1:9222/json/list` 拿 `webSocketDebuggerUrl`，再 `Runtime.evaluate({returnByValue:true})` 读 `document.body.innerText` / DOM；必要时在页面放可见 debug 打点区分「没调用」与「调用后抛错」，定位后删除。

### 语言与国际化

- 默认中文 `zh-CN`，语言可配置（`core/config` 的 `language`）。
- **前端（uni-app）与后端（网关 `xiaoxiong-app/gateway`）都必须支持国际化（i18n）**，禁止在代码里硬编码中文用户文案。
- 前端：文案走 `core/i18n` 消息目录，按 `language` 取值；不引入 `vue-i18n`。
- 后端：智能体系统提示、下发给客户端的 `error` 文案等都按 `session.start` 的 `lang` 本地化，文案进 `xiaoxiong-app/gateway/src/i18n.ts` 的目录，按 `lang` 取值。
- 唤醒词、ASR、TTS 的默认语言跟随全局配置；厂商参数留空即继承。

### 配置

- 配置模型：`运行模式 → 厂商 → 参数`。
  - `mode`: `byok`（自带服务，当前唯一可用）/ `platform`（平台托管，登录 + 计费后开放）。
  - 每类能力（asr / llm / tts）存 `provider` 与 `byProvider`，切换厂商不丢参数。
- 存储 key：`app-product.config.v1`，只存本机，不同步云端。
- 新增厂商：只改 `core/config/providers.ts` 的模板（vendor、默认值、fields），不要改设置页的渲染逻辑。
- 参数值必须经 `coerceFieldValue` 收敛（数字范围、单选合法性、布尔），脏配置不能带崩运行时。
- API Key 只在本机；平台模式上线后由网关持有，客户端不落 Key。

### 本地数据

- 小、同步读的配置：`uni.setStorageSync` / `getStorageSync`。
- **设备数据、会话记录、命令日志的权威存储移到 Node 网关（`xiaoxiong-app/gateway` 的 SQLite），客户端经 REST 接口读写**；`core/database` 仅作离线缓存或降级，不直接写业务数据。
- SQL（网关侧 Node 端）必须用参数化查询，禁止把外部字符串直接拼进 SQL。
- H5 开发阶段没有 `plus.sqlite`，`isSupported()` 为 false，调用方需降级。
- 设备数据默认存本地；付费用户后续可同步云端，云端不是当前实现。

### 协议

- 客户端 ↔ 服务端消息以 `contracts/README.md` 为准，先改契约再改代码。
- 上行音频：16kHz / 16bit / 单声道 PCM。
- 下行事件：`asr.partial` / `asr.final` / `llm.delta` / `tts.*`，新增类型必须同步契约文档。

### 网关（后端 Node.js）

- 后端是独立 Node 服务 `xiaoxiong-app/gateway`，是客户端**唯一**允许的通信对象：语音走 WebSocket，数据走 REST，第三方能力（ASR / LLM / TTS / 数据库）只在网关这一侧落地。
- **前端不得直接调用任何第三方服务**，一律经 Node 网关转发；客户端只与网关通信。
- **第三方地址只由网关持有**：`VOICE_BUILTIN_URL` / `VOICE_DASHSCOPE_URL` 等来源地址写在网关配置（或 `.env`）里，前端**绝不**把来源地址（如 `http://127.0.0.1:9529`）传给后端当 fetch 目标。前端调 `/api/*` 时只传业务参数（如 `provider`），由网关用自身配置去中转拉取；api-key 这类只落本机的密钥可从前端带来，但地址不行。
- **每次新增前端→后端的取数/调用**，先确认它只打到网关、且目标地址来自网关配置，而不是前端拼出来的 URL。
- 数据库只在 Node 端落地（SQLite via `node:sqlite`）；客户端经 REST 读写，不再直接写业务数据到 `plus.sqlite`（`core/database` 仅作离线缓存/降级）。
- 所有后端接口需提供 Swagger / OpenAPI 文档（网关 `/docs`），新增或修改接口先更文档。
- 后端文案按 `lang` 本地化（见「语言与国际化」）。
- **设置接口免登录**：`/api/admin/*`（长期记忆、语音服务配置、LLM 模型目录、TTS 音色目录）是语音助手设置页自身使用的接口，**永远不需要登录、不做任何鉴权**。不要为这些端点加登录开关或 Bearer 拦截——它们面向本机设置页，登录只属于未来的平台托管模式（届时由不同入口承载）。详见 `xiaoxiong-app/contracts/README.md` 的「设置接口」小节与 `gateway/src/controller/apiController.ts`。其它模块若需要这些能力，不要复用 `/api/admin/*`，应新开接口。

### 音频与唤醒

- 唤醒后立即播本地招呼，不等 WebSocket 建连；提示音、结束语都走本地文件（H5 用 WebAudio）。
- 播报时不能自唤醒、不能把播报当成用户说话。
- 原生唤醒插件名固定 `app-product-wake`。JS 接口：`start / stop / onWake / onError`（唤醒），以及 `startPcm / stopPcm / onPcmFrame / onPcmError`（App 端实时 PCM 采集，见 `xiaoxiong-app/uni_app/src/core/audio/appCapture.ts`）。App 端**不用** `uni.getRecorderManager` 做对话采集：它只能录成文件、App 不支持 `onFrameRecorded`，拿不到网关要求的实时 PCM 分片。
- **本地提示音音色要自然、且与 App 在线 TTS 统一**：`static/audio/*.mp3`（greeting / still-there / farewell）用自然中文神经 TTS 音色（`edge-tts` 的 `zh-CN-XiaoxiaoNeural`），**不要**用 macOS `say` 的默认机器人嗓音（用户觉得不好听）。重新生成提示音或改网关 TTS 音色时保持同一嗓音。具体地址 / 模型名从配置读，不写死在代码里。

### 代码风格

- TypeScript strict 通过；不要用 `any` 绕过类型，必要时用 `unknown` + 收窄。
- 注释写“为什么”，不写“是什么”；中文注释，与现有代码一致。
- 单个文件保持聚焦；新能力优先加文件，不把逻辑堆进页面。
- 单测覆盖纯逻辑：状态机、唤醒词、配置收敛、SQL 转义。UI 与原生插件不做单测。

## 实践约定与踩坑（长期有效）

### 用户交互与内容意图

- **页面可见文案全部走 i18n**（见「语言与国际化」），唯一例外是识别出的语音原文，按原样显示。
- **用户说了内容类型就按类型办**：说"评书 / 相声 / 有声书"当内容播放，不要当点歌，措辞也别说"这首歌"。
- **视频类内容要能播放音频**：电视 / 电影 / 动画走 B 站音轨抽取播放，不能回复"无法播放视频 / 没有这个能力"；找不到只说"没找到"。
- **音乐 / 字幕同源**：点歌优先从歌曲宝详情页一次拿齐同源音频 / 封面 / LRC，拿不到再走 B 站 + 百度兜底。音频与字幕必须同源同曲，跨源宁可显示"暂无字幕"，绝不配第三方歌词库（第三方源已删）。
- **字幕只展示不播报**：同源字幕只在界面显示，绝不经 TTS 朗读，也不让 LLM 复述原文。
- **"再"字表示全新请求**：语音指令含"再"（再放 / 再减…）时关掉跨轮上下文，不沿用上一轮的歌手 / 状态。
- **少调 LLM**：高置信控制指令（音乐 / 音量 / 记忆等）直连绕开大模型，不进 LLM。
- **回复要诚实**：关闭字幕 / 暂停 / 停止等确认必须反映真实状态；没字幕、没在播放就别说"已显示 / 已暂停 / 已关闭"；保存配置连不上或写失败要如实报错，不谎报成功。
- **详情卡片**：编号同行最前、列表显示字段、缺值占位、来源显示站点名、选号跨轮保留且量词通用、关详情回列表、无朋友圈入口、各 kind 共用同一协议。
- **展示信息克制**：面板别默认加语义重复的状态列。

### 权限与位置

- **定位等敏感权限懒加载**：只在问到天气 / 附近时才 `client.location.request`，绝不在建连 / 冷启动就取位置、弹权限框。
- **权限提醒按必要性分级**：麦克风未授权要播 mp3 提示音；定位非必须，只显示状态、不播报；用三色状态区分。

### UI 与展示验证

- **不用文字浮层**：任何提示都不用 `uni.showToast`，只放页面固定区域的行内文字。
- **横竖屏与跨机型一致**：UI 改动横屏竖屏都要适配、所有机型一致；状态栏高度用 JS 读系统值，别依赖 CSS env/var。
- **首页统一单列**：`pages/index/index.vue` 横竖屏都单列，不做左右分栏；横屏要铺满不留黑边（黑边根因在 `App.vue` 的全局限宽规则，不在首页 scoped）。
- **UI 改动必须在真机 / 真实页面点击验证**：用 Playwright 驱动真实 WebView / Chrome 点击看效果，或截图 + PIL 像素差分；代码层"等价验证"不算数。本项目 `console.log` / `pageerror` 收不到日志，别指望它们。

### 配置、协议与目录数据

- **配置值来自用户设置**：LLM 模型、音色等默认留空，由设置页提供并统一保存落盘；网关不硬编码字面量、不读 env、不运行时调接口解析。
- **不硬编码服务地址**（见「网关」）：自请求 / 拼 URL 别写死 `127.0.0.1:端口`，调内部分支或从配置读。"语音设置 / 模型字段 / 保存配置"指 uni-app 客户端设置页（内置 + dashscope 两源都要覆盖），不是 9529 管理面板。
- **LLM 默认模型按提供商维度**：每个提供商分组各有自己的默认模型，真相源 `*_UPSTREAM_DEFAULT_MODELS`（`{vendor: model}` map），与"默认供应商"解耦；`*_UPSTREAM_VENDOR` 与默认模型是两个独立维度。
- **协议是模型级字段、只写调用形态**：协议值只能 `http` / `ws` / `http-async`，不带厂商 / 引擎名 / 端点路径；跟在模型行上，不在提供商行旁单列；厂商由 `provider` 表达；内置 ASR / TTS 就是 `http`。
- **协议 / 模型目录权威源**：9529 代理的协议 / 模型目录对齐 Java 工程 `fw-plus-ai-native`（`LlmProtocol` / `LlmVendor` / `ModelType`），其 LLM / EMBEDDING / RERANK 三端口映射到 9529 的 LLM / TTS / STT。
- **目录数据必须放 seed 文件 + 初始化脚本**：音色、ASR / TTS 模型等静态目录放 `scripts/voice/seed/*.json`，由 `scripts/voice/init_catalog.py` 幂等灌库，禁止硬编码在业务代码里。
- **控制类参数须真下发**：思考开关要真到上游让模型生效，不能只隐藏 UI；对外固定用 `think`，代理按厂商翻译。

### 代理服务与存储架构（9529）

- 9529 语音代理：本地 SQLite 作配置真相源 + Redis 远程缓存 + Postgres 远程库，统一收口到 `config_store` 门面（调用方无感）。
- 对外当前只有 HTTP 语音接口；对外 WS 接口待测试页完善后再加。
- DeepSeek 官方语音：ASR `/v1/tools/asr`、TTS `/v1/tools/tts`，音色 stella / tide，调用协议 `http`，密钥走 `STT_DEEPSEEK_API_KEY` / `TTS_DEEPSEEK_API_KEY`。
- **本地真实服务联调的网关实现坑**（地址 / 模型名一律从配置读，不写死）：语音服务接口可能在**根路径**（`/v1/audio/transcriptions`、`/v1/audio/speech`）而非某个前缀，接错路径会 404；ASR 服务常要求 **RIFF/WAV**，纯 PCM 上报 `does not start with RIFF id`——`asr/http.ts` 要把上行 16k PCM 补 44 字节 WAV 头再 multipart 提交；TTS 返回的 24k/16bit/单声道 WAV 直接剥头下发 PCM、无需重采样。上游 LLM 曾因余额耗尽返回 402，联调 LLM 可改走本机 Ollama 绕开付费代理。排查「对不了话」先分清是地址、接口路径、WAV 头还是上游余额问题，别急着改前端。

### 打包、真机调试与环境坑

- **每次打包网关必须一起打**：网关是 App 同包内嵌组件，出 iOS / Android 包时网关 bundle 必须同步 `npm run build:bundle` 并打入，绝不留旧 / 缺网关；`package-*-offline.mjs` 已自动先构建再拷，不要改成"只拷不构建"。
- **Android 出包链**：`npm run build:app` → `node scripts/package-android-offline.mjs --appid __UNI__145C29C`（自动重建并放置网关 bundle）→ SDK 壳目录 `./gradlew :app:clean :app:assembleDebug` → `node scripts/install-android-offline.mjs` 干净安装（先卸载再装以强制刷新 www，别用裸 `adb install -r`）。改完前端必须 force-stop 再启动，否则可能跑旧包。
- **干净安装必须补回运行时权限**：`adb uninstall` 重装会清掉麦克风等所有运行时权限，而 ADB 静默安装不弹授权框——结果就是「显示待唤醒但喊小熊小熊没反应 / 对话采不到音」。`install-android-offline.mjs` 已在安装后 `pm grant RECORD_AUDIO`（连同 Doze 白名单一起补）；改动安装流程时别漏掉这步，排查唤醒失效也先查 `dumpsys package <pkg> | grep RECORD_AUDIO` 的 granted 状态。
- **唤醒架构是网关 ASR，不是本地 KWS**：前端采集 PCM 上行、网关 ASR 识别成文本后前端 `matchWakeWord` 匹配「小熊小熊」；所以唤醒前提是 `canWake() = 网关可用 + ASR reachable`，且麦克风权限已授予。`core/wake/wakeService.ts` 的原生 KWS provider 目前未接入主流程，别误以为唤醒靠它。
- **App 端 `uni.connectSocket` 必须传回调拿同步 SocketTask（唤醒失效根因，血泪）**：DCloud 的 `uni.connectSocket` 被 `promisify` 包装。不传 `success/fail` 时返回的是 Promise，`resolve()` 出来只有 `{errMsg}`、**拿不到 SocketTask**；若此时退回 `uni.onSocketMessage` 全局回调，运行时（`uni-app-plus` 的 `socketStateChange`）**只把消息投递给 `socketTasks[0]`**，且 `sendSocketMessage` 也只发 `socketTasks[0]`——反复建连后归属错乱，网关的 `asr.partial/final` 下行全部丢失，表现就是「PCM 在采、网关 health 正常、但喊小熊小熊永远唤不醒」。解法（见 `core/transport/webSocketTransport.ts` 的 `createSocket`）：`connect({ url, success: () => {}, fail: () => {} })`，让 promisify 走 `hasCallback` 分支**同步返回真正的 SocketTask**，用 `likeFromTask` 注册每条连接自己的 `onOpen/onMessage/onClose/onError` 局部回调。别再走全局回调或靠返回值 Promise。排查法：`/api/sessions` 看是否一个 deviceId 建了多条 active session（重复建连特征）；页面可见打点看是否出现 `task.onMessage`（通）还是只有 `GLOBAL onSocketOpen`（错）。
- **App 逻辑层无 `new URLSearchParams`**：设置页四个下拉曾全空/disabled，真因是 App 独立 JS 引擎里 `new URLSearchParams(...)` 抛异常，且参数构造在 `try` 外导致静默中断（H5 正常）；改用 `encodeURIComponent` + 字符串拼接并把参数构造放进 `try`。禁止再用"旧代码/缓存"解释——hint 消失即证明新代码已生效，要用 CDP/截图/MD5 自证。
- **自定义 `UniModule` 必须代码注册**：`uni.requireNativePlugin('app-product-wake')` 查的是 `WXSDKEngine.registerModule` 表，`dcloud_properties.xml` 的 `<feature>` 是老式 `plus.bridge.exec` 机制、对 `UniModule`/`@UniJSMethod` 无效。必须在 `App.java` main 进程 `onCreate` 调 `UniSDKEngine.registerUniModule("app-product-wake", WakeModule.class, false)`，否则 requireNativePlugin 返回 `undefined`，`isAppCaptureSupported` 访问其方法抛错中断唤醒链。loadPcmModule 要处理 `undefined`（不是只有 null）。
- **DCloud/weex callback 回传 `byte[]` 到前端会变成普通 `number[]`**：`WakeModule` 的 `pcmFrameCb.invokeAndKeepAlive(frame.clone())` 出来的不是 ArrayBuffer 也不是 Uint8Array，而是 `ctor=Array keys=0,1,...`。`appCapture.ts` 的 `toArrayBuffer()` 必须兼容 `Array.isArray(frame)` 逐字节转 Uint8Array，否则每帧被丢弃、网关收不到任何音频。
- **App 端「文字不播报」= TTS 走了 WebAudio，必须改原生 AudioTrack**：App 逻辑层没有 WebAudio，`useAssistant.ts` 若直接用 `core/audio/h5Audio.ts` 的 `playPcm`（AudioContext），网关下发的 TTS PCM 帧到达却静默失败——AI 有文字、没声音。正解：新建 `core/audio/appPlayback.ts`（`appPlayPcm` / `onAppPlaybackIdle` / `stopAppPlayback` / `isAppPlaybackSupported`）走 `app-product-wake` 原生插件的 AudioTrack，`useAssistant.ts` 用 `playTts` / `waitPlaybackIdle` / `stopTts` 门面按能力探测分流（App→原生，H5→WebAudio）。原生 `WakeModule.java` 提供 `startPlayback(int)` / `playPcm(JSONArray 0-255字节)` / `stopPlayback` / `onPlaybackIdle`，24k/mono/16bit MODE_STREAM 顺序写，起线程用 `getPlaybackHeadPosition() >= writtenFrames` 判播空回调。两个坑：① `app-product-wake` 是非单例模块（注册第三参 `false`），appPlayback 必须缓存 `requireNativePlugin` 结果，否则每帧投给不同实例、播放不连贯；② `onAppPlaybackIdle` 必须用 `playbackInFlight` 标志——PCM 短时原生 idle 会早于 `tts.end` 到达，注册等待者时若已播完要立即兑现，否则网关收不到播完回执、排队句卡死（对齐 h5Audio.onPlaybackIdle 的语义）。
- **App 端「播放的音乐被识别 / 我在·还在吗打断音乐 / 点歌误触发」= 采集无 AEC 的回声**：App 采集原来用 `AudioSource.VOICE_RECOGNITION` 无 AEC，扬声器外放的音乐/本地提示音（greeting「我在」/stillThere「还在吗」）/TTS 被麦克风收回，ASR 识别成「暂停/播放/播放一首周杰伦的ys」等指令 → 误操作。H5 靠 `getUserMedia({echoCancellation:true})` 抵消，App 必须靠原生 AEC：`WakeModule.java` 采集源改 `VOICE_COMMUNICATION` + `AcousticEchoCanceler.create(audioSessionId).setEnabled(true)`（带 `isAvailable()` 降级、stopCapture 时 release）。真机验证法：logcat `grep WakeModule` 应见 `WakeModule: AcousticEchoCanceler enabled`。**不要粗暴全程静音麦克风，也不要在网关加文本规则拦幻觉/歌词回声**——用户要求对标 H5 的 ducking（助手说话时音乐变小、说完恢复），纯文本无法可靠区分回声与正常点歌、易误伤，从采集源用 AEC 治理。
- **悬浮播放器「偏高」**：`FloatLayer` 顶部锚点原本固定 `FLOAT_INSET=16px`，没让出状态栏，悬浮球顶进状态栏。已加 `topInset` prop，顶部锚点用 `calc(16px + topInset)`；首页 `<FloatLayer id="music-disc">` 传 `:top-inset="isLandscape ? 8 : screen.statusBarHeight"`（横屏不留状态栏余量传 8）。验证法：CDP 读首页 `.page` 的 `padding-top`（=statusBarHeight+2），确认逻辑层 statusBarHeight 有值即可。
- **DCloud**：应用"小熊助手"，AppID `__UNI__145C29C` 已填 manifest；构建前确认账号邮箱已验证 + AppKey 已写入，否则 HBuilderX 登录 / 离线打包会被拦。
- **逻辑层无 `document`**：App 端 `app-service.js` 没有 `document`，直接改 `document.documentElement.style` 是空操作；换主题必须靠 Vue `:style` 响应式绑定把 CSS 变量落到视图层 `.page` 上。
- **真机 CDP 调试**：`adb forward tcp:9222 localabstract:webview_devtools_remote_<PID>`（重开 App 后 PID 会变要重做），`curl http://127.0.0.1:9222/json/list` 拿 `webSocketDebuggerUrl`，用 CDP `Runtime.evaluate({returnByValue:true})` 读 DOM / innerText；必要时在页面放可见 debug 打点区分"没调用"与"调用后抛错"，定位后删除。
- **真机 ASR 联调**：先 `adb reverse tcp:9529 tcp:9529` 把设备 localhost:9529 转到本机 9529；探测设备网关用 `adb forward`。联调地址 / 模型名从配置读，不要写死。
- **设备访问本机服务连不通**：先排查 macOS 防火墙丢弃 LAN 入站（localhost 200 但 LAN IP 000），以及 WiFi AP 隔离（ping 不通但能上外网，用 adb reverse 或关 AP 隔离）。
- **iOS 离线包**：`control.xml` 的 appid 别用示例值、Pandora 要进包、网关动态端口要与前端端口一致，否则白屏；Xcode 26.3 配 26.2 SDK 致 ibtool 报 Platform Not Installed，用 `UILaunchScreen` 绕过。
- **iOS 重签脚本容错**：`reprovision.sh` 里设备离线静默忽略、"待信任开发者 / 待开开发者模式"都算正常，汇总三态后 `exit 0` 不报错；只看 `Installed package` 是假成功。
- **悬浮层通用架构**：`core/adaptation/floatLayer` + 通用 `FloatLayer` 容器（slot + 统一 z-index），播放器只是第一个使用方，新悬浮内容复用它。
- **协作提醒**：跨轮次可能丢失刚回答的内容，关键决定写入记忆或显式复述确认后再继续。

## 当前阶段与路线

1. 基础：唤醒、会话状态机、本地招呼、配置页（**当前**）。
2. 设备控制：BLE / Wi-Fi 设备发现、配对、语音命令。
3. 设备数据：采集后写 SQLite；付费用户后续同步云端。
4. 登录 + 计费：平台托管模式，付费用户免配置 ASR / LLM / TTS。
5. 设备商城：App 内购买设备，形成「语音 → 设备 → 硬件收入」闭环。

设备控制的架构预留见设计文档第 15 节；不要提前实现设备协议，等真实设备与协议确定。

## 不要做的事

- 不要把 AgentScope 装进客户端：它只能在 Node 网关运行。
- 不要在前端直接调用第三方服务（ASR / LLM / TTS / 数据库等）；客户端只与 Node 网关通信。
- 不要把数据库写逻辑放进客户端；SQLite 只在 Node 网关落地。
- 不要为 H5（仅开发阶段）补复杂降级逻辑，更不要为已确定不支持的小程序 / 鸿蒙写任何分支，除非明确要求。
- 不要引入第二套状态管理或第二个 UI 框架。
- 不要提交密钥、真实用户数据、设备数据。
- 不要在没有验证的情况下修改 `contracts/` 并声称兼容。
