# app-product

语音助手客户端 + 同包 Node 网关。一套 uni-app（Vue3 + TypeScript + Vite）代码，
**目标端只有 Android / iOS App**（自定义基座 + 原生插件）；H5 仅开发阶段调试用。

主链路：**网关 ASR 识别唤醒词「小熊小熊」→ 本地招呼「我在」→ 语音对话 →
T1 静默提示 → T2 退出本轮 → 回到待唤醒**。

> 微信小程序与 HarmonyOS 确定不支持，代码里不保留它们的降级分支。
> 客户端只与网关通信；ASR / LLM / TTS / 内容源都由网关侧接入，前端不直连第三方。

## 能力

### 语音对话

- 唤醒：App 采集 PCM 上行，网关 ASR 出文本，客户端 `matchWakeWord` 命中「小熊小熊」；
  唤醒后立即播本地招呼，不等 WebSocket 建连。**不是本地 KWS**。
- 唤醒模式（`session.start.mode='wake'`）只跑 ASR，不跑 LLM / TTS；命中唤醒词后
  切到 `dialog` 模式开始一轮对话。
- 静默两段计时：T1 提示「还在吗？」，T2 无回应则退出本轮，回到待唤醒。
- 思考 / 播报期间插话排队（最多 3 句），当前句播完后按序处理；只有「小熊小熊」
  能打断当前句（客户端发 `session.skip_current`，只跳当前、不清队列）。
- 回声治理：原生采集侧 AEC + 网关侧软件 AEC（NLMS，用下发 TTS 作参考消回声）+
  strict VAD / 能量门控 / 已播文本比对 / 杂音与外语过滤。
- App 端音频走原生直连：上行 PCM 与下行 TTS 都经 `?role=pcm` WebSocket 在原生层
  收发，绕开播报期不可靠的 weex 回调；TTS 由原生 AudioTrack 播放，本地提示音走
  不抢音频焦点的原生 MediaPlayer。
- 语言：界面支持 `zh-CN` / `en-US`；语音链路默认中文，识别语言与 TTS 音色随全局
  语言 / 语音来源配置。

### 内容与工具

- **点歌 / 音频内容**：百度源（歌曲宝详情页同源音频 + 封面 + LRC，拿不到再走 B 站
  音轨 + 百度兜底）；评书 / 相声 / 有声书 / 电视 / 电影 / 动画等视频类内容抽取 B 站
  音轨播放音频；SomaFM 风格电台。B 站 dash 音轨由网关转封装 ADTS 并以短链
  `/music/s/<key>.aac` 下发。
- **字幕**：同源字幕只展示、不播报，不配第三方歌词库；无同源字幕时显示「暂无字幕」。
- **播放控制**：播放 / 暂停 / 继续 / 停止 / 上一首 / 下一首 / 音量 / 循环 / 自动字幕；
  顶部播放条 + 字幕面板 + 可拖拽悬浮唱片播放器。
- **天气、时间 / 日期 / 农历、择吉日**：时间按配置时区返回；问日期报全阳历 + 星期 +
  农历；问吉日用内置黄历宜忌数据扫未来 30 天。历法表述固定中文。
- **好价商品**：什么值得买好价查询，详情卡片支持编号选择、跨轮保留候选。
- **新闻播报**：说「播放新闻 / 头条 / 科技新闻 / news」等，网关走百度新闻频道抓当日头条或话题新闻，直接口播「标题 + 来源」，绕开大模型、不发卡片；抓取失败或没查到会诚实说明，不编造新闻。引导与兜底文案按语言本地化，标题保持原文。
- **长期记忆**：网关 SQLite 存储，支持手动「记住 / 忘掉」与可选的自动抽取 / 合并。
- **MCP 工具**：设置页添加 stdio / sse / http MCP 服务器，网关连接后把工具注册进
  助手工具箱，可按工具白名单 / 黑名单启用。
- **我的收藏**：当前为客户端内存列表演示（自动收藏流程可见），网关持久化接口待接。

### 设置

设置页按「运行模式 → 语音来源 → 参数」组织：

- 运行模式：`byok`（自带服务，当前唯一可用）/ `platform`（平台托管，登录 + 计费后开放）。
- 语音来源：`builtin`（内置 / 自建 9529 服务）与 `dashscope`（阿里云百炼），
  两份地址、Key、模型各自独立保存，切换来源不丢参数。
- 每个来源可选 LLM 模型、ASR 模型、TTS 模型 / 音色；下拉选项由网关实时从来源拉取，
  默认留空由来源决定。
- 播放设置（播放源、自动字幕、默认循环 / 音量、悬浮播放器、字幕字号 / 颜色）、
  好价条数、自动连接、主题、自动记忆、MCP 服务器。
- 一键检测：按当前来源探测 LLM / ASR / TTS 地址与模型可用性，并检查外网连通性。

## 架构

```
App（Android / iOS）
├── uni-app 界面（Vue3 + TS）
├── 原生插件 app-product-wake
│   ├── PCM 采集 / 播放（AudioTrack、AEC、本地提示音）
│   └── ?role=pcm 原生直连网关（上行 PCM + 下行 TTS）
└── 内嵌网关（nodejs-mobile，127.0.0.1:<动态端口>）
        ├── WS /ws：语音会话、事件、TTS 音频
        ├── REST /api/*：健康、会话、记忆、模型目录、配置
        ├── SQLite：会话 / 记忆 / 命令日志 / 设置备份（权威存储）
        ├── AgentScope TS：智能体、工具、MCP
        └── 外网内容源：B 站 / 百度 / 歌曲宝 / 什么值得买 / SomaFM
                 │
        ┌────────┴────────┐
        │                 │
   9529 本地 AI 服务    DashScope 云端
   （STT / TTS / LLM / Embeddings）
```

- **网关是客户端唯一后端**：语音走 WS，数据走 REST；第三方能力只在网关落地。
- **会话与连接解耦**：客户端持久化 `deviceId`，重唤醒 / 重连复用同一会话
  （保留对话记忆与待选歌单），`session.end` 才真正结束。
- **App 内嵌运行**：Android 在 `:gateway` 独立进程、iOS 在 App 进程内后台线程启动
  nodejs-mobile，网关只绑 `127.0.0.1`，端口由系统分配并写入 `.gateway_port`；
  桌面开发时网关是普通 Node 进程（默认 `8787`）。
- **配置存储**：客户端本机 `app-product.config.v1` 为主；设置页「保存配置」可把整份
  `AppConfig` 备份到网关 SQLite，按 `deviceId` 覆盖更新。

## 目录

```
app-product/
├── model-proxy/                  # 本地 AI 服务（9529）+ Ollama / 服务编排脚本
├── xiaoxiong-app/
│   ├── uni_app/                  # uni-app 客户端
│   │   └── src/
│   │       ├── core/             # 状态机、唤醒词、音频、配置、传输、i18n、适配
│   │       ├── features/         # 业务编排：助手、记忆、详情、收藏、推荐
│   │       ├── pages/            # 首页 / 设置 / 收藏 / 好价 / 长期记忆 / MCP
│   │       └── static/audio/     # 本地招呼与提示音
│   ├── gateway/                  # Node 网关（WS 语音 + REST 数据 + SQLite + AgentScope）
│   ├── native/                   # Android / iOS 原生工程（唤醒插件、网关壳、framework）
│   ├── scripts/                  # 开发服务器、打包、真机安装、USB 联网脚本
│   └── contracts/                # 客户端 ↔ 网关协议契约（唯一协议来源）
├── docs/                         # 设计文档、内嵌网关方案、DashScope WS 语音说明
└── AGENTS.md                     # 协作约定与踩坑记录
```

## 技术栈

| 层 | 选型 |
|---|---|
| 客户端 | uni-app（Vue3 + TypeScript + Vite），仅 Android / iOS App |
| 原生桥 | Android Java 插件 `app-product-wake`；iOS `XiaoxiongGateway` framework |
| 网关 | Node + AgentScope TS + `ws` + Drizzle ORM + SQLite（`node:sqlite`） |
| 内嵌运行时 | nodejs-mobile（Node 24.20.0），Android `:gateway` 进程 / iOS 后台线程 |
| 本地 AI 服务 | Python FastAPI（9529）：SenseVoice STT、edge-tts TTS、LLM / Embeddings 代理 |
| 数据 | 网关 SQLite 为业务数据权威源；客户端本机存储只放配置与设备标识 |
| 协议 | `xiaoxiong-app/contracts/README.md`；网关 Swagger `/docs` |

## 快速开始

### 客户端

```bash
cd xiaoxiong-app/uni_app
npm install
npm run test          # vitest
npm run type-check    # vue-tsc
npm run dev:h5        # 浏览器调试 UI / 链路
npm run dev:app       # Android / iOS（需 HBuilderX / 自定义基座）
```

### 网关（桌面开发）

```bash
cd xiaoxiong-app/gateway
npm install
npm run dev           # tsx watch，默认 8787
npm run test
npm run type-check
```

### 本地 AI 服务（9529）

```bash
./model-proxy/install-voice.sh    # 首次安装（venv + 依赖 + SenseVoice 模型）
./model-proxy/voice.sh start      # 后台启动
./model-proxy/voice.sh status
./model-proxy/voice.sh log
./model-proxy/voice.sh stop
```

Windows 用同目录下的 `.cmd`（`model-proxy\install-voice.cmd`、`voice.cmd` 等）。
管理面板：`http://127.0.0.1:9529/admin`；安装、配置、鉴权、模型目录与测试说明见
`model-proxy/README.md`。

### 一键启停（macOS / Linux）

```bash
./model-proxy/services.sh start          # ollama / voice / gateway / uniapp
./model-proxy/services.sh status
./model-proxy/services.sh log voice -f
./model-proxy/services.sh stop all
```

### 真机出包

`build.sh` 会自动全量重编译前端与网关 bundle（先清 `dist` 与 vite 缓存），再接入 DCloud
离线 SDK。首次使用先把 `xiaoxiong-app/scripts/.build_env.example` 复制成
`.build_env.dev` / `.test` / `.pro` 并填 appid / AppKey（该文件不入库）。

```bash
cd xiaoxiong-app
./scripts/build.sh dev android            # 前端 + 网关 bundle + APK，产物在
                                          # native/android/app/build/outputs/apk/debug/
node scripts/install-android-offline.mjs  # 干净安装 + 补麦克风权限 + Doze 白名单
```

iOS：`./scripts/build.sh dev ios` 完成资源接入与壳工程集成，再用
`native/ios/reprovision.sh` 做真机构建 / 重签 / 装机（详见 `xiaoxiong-app/native/README.md`）。

真机联调需要 `adb reverse tcp:9529 tcp:9529`，让设备上的网关访问电脑的本地 AI 服务；
拔线或重启后反代会掉，重插后要重建。

## 配置模型

| 层 | 说明 |
|---|---|
| 运行模式 | `byok` 自带服务（当前可用）；`platform` 平台托管（登录 + 计费后开放） |
| 语音来源 | `builtin` 内置 / 自建 9529；`dashscope` 阿里云百炼；各存一份 url / apiKey |
| 能力参数 | LLM `model`、ASR `asrModel`、TTS `ttsModel` + 音色 `voice` / `voiceModel` |
| 行为设置 | 播放源 / 字幕 / 循环 / 音量、好价条数、自动连接、主题、记忆、MCP |

参数值统一经 `coerceFieldValue` 收敛（数字范围、枚举合法性、布尔），脏配置不会带崩
运行时。API Key 只落本机；平台模式上线后由网关持有，客户端不落 Key。

## 协议与数据

- **唯一协议来源**：`xiaoxiong-app/contracts/README.md`。先改契约再改代码；新增事件 /
  接口必须同步契约。
- 语音 WS：`/ws?deviceId=<id>`，客户端上行 PCM、JSON 控制帧；网关下发
  `asr.*` / `llm.*` / `tts.*` / `media.*` / `audio.*` 事件与 TTS 二进制音频。
- 原生音频直连：`/ws?deviceId=<id>&role=pcm` 是内部音频专用连接，只收发音频帧、
  不绑定会话，避免抢走 JS 连接的事件下发。
- REST：`/api/health?deep=1`、`/api/sessions`、`/api/command-logs`、
  `/api/admin/{config,memories,llm-models,tts-voices,voice-models}`、`/api/diag`、
  `/music/stream?url=`、`/music/s/<key>.aac`；Swagger `/docs`、`/api/openapi.json`。
- 设置接口 `/api/admin/*` 面向本机设置页，免登录；登录只属于未来的平台托管模式。

## 当前状态

- Android 真机已跑通主链路并完成多轮回归：网关 ASR 唤醒、对话、TTS 播报、播报期插话排队、
  点歌 / 字幕 / 播放器、天气 / 时间 / 好价 / 新闻播报、长期记忆、MCP、多语音来源切换。
- iOS 已具备同包网关 framework、原生插件与离线打包链，真机联调按 `native/ios` 流程进行。
- H5 仅用于 UI 与链路调试，不是交付端；小程序 / 鸿蒙不提供实现。
- 已知限制：
  - 「我的收藏」只有客户端内存列表，网关持久化接口未实现；
  - 平台托管模式（登录 + 计费）未开放；
  - 播报期喊「小熊小熊」打断仍在优化（普通插话已可用）；
  - 设备控制 / 设备数据 / 设备商城属于后续阶段。
- 提交前必须跑 `npm run test` 与 `npm run type-check`（客户端、网关各自）。

## 路线图

1. 基础能力：唤醒、会话状态机、本地招呼、语音对话、配置页（当前阶段）。
2. 设备控制：BLE / Wi-Fi 设备发现、配对、语音下发命令。
3. 设备数据：采集后写网关 SQLite；付费用户后续同步云端。
4. 登录与计费：平台托管模式，付费用户免配置 ASR / LLM / TTS。
5. 设备商城：App 内购买设备，形成「语音入口 → 设备控制 → 硬件收入」闭环。

## 文档

- 协议契约：`xiaoxiong-app/contracts/README.md`
- 设计文档：`docs/superpowers/specs/2026-11-06-app-product-design.md`
- 内嵌网关方案：`docs/mobile-embedded-gateway.md`
- DashScope WS 语音：`docs/dashscope-ws-voice.md`
- 客户端说明：`xiaoxiong-app/uni_app/README.md`
- 原生层说明：`xiaoxiong-app/native/README.md`、`xiaoxiong-app/native/ios/app/README.md`
- 本地 AI 服务：`model-proxy/README.md`
- 协作约定与踩坑：`AGENTS.md`
