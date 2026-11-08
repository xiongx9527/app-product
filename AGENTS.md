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
- 数据库只在 Node 端落地（SQLite via `node:sqlite`）；客户端经 REST 读写，不再直接写业务数据到 `plus.sqlite`（`core/database` 仅作离线缓存/降级）。
- 所有后端接口需提供 Swagger / OpenAPI 文档（网关 `/docs`），新增或修改接口先更文档。
- 后端文案按 `lang` 本地化（见「语言与国际化」）。

### 音频与唤醒

- 唤醒后立即播本地招呼，不等 WebSocket 建连；提示音、结束语都走本地文件（H5 用 WebAudio）。
- 播报时不能自唤醒、不能把播报当成用户说话。
- 原生唤醒插件名固定 `app-product-wake`。JS 接口：`start / stop / onWake / onError`（唤醒），以及 `startPcm / stopPcm / onPcmFrame / onPcmError`（App 端实时 PCM 采集，见 `xiaoxiong-app/uni_app/src/core/audio/appCapture.ts`）。App 端**不用** `uni.getRecorderManager` 做对话采集：它只能录成文件、App 不支持 `onFrameRecorded`，拿不到网关要求的实时 PCM 分片。

### 代码风格

- TypeScript strict 通过；不要用 `any` 绕过类型，必要时用 `unknown` + 收窄。
- 注释写“为什么”，不写“是什么”；中文注释，与现有代码一致。
- 单个文件保持聚焦；新能力优先加文件，不把逻辑堆进页面。
- 单测覆盖纯逻辑：状态机、唤醒词、配置收敛、SQL 转义。UI 与原生插件不做单测。

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
