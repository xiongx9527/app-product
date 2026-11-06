# app-product

语音助手客户端。一套 uni-app（Vue3 + TypeScript + Vite）代码，覆盖 Android / iOS / HarmonyOS App。

核心链路：**本地唤醒 → 打招呼 → 语音对话 → 静默提示 → 退出本轮 → 继续待唤醒**。

## 特性

- 本地唤醒词「小熊小熊」，唤醒后立即播本地招呼「我在」，不等网络。
- 静默两段计时：T1 提示「还在吗？」，T2 无回应则退出本轮，回到待唤醒。
- ASR / LLM / TTS 全部可配置：按厂商选择，参数独立保存。
- 支持自带服务（BYOK）直连厂商或本地服务；登录与计费上线后支持平台托管，付费用户无需配置。
- 语言可配置，默认 `zh-CN`。
- 设备控制、设备商城、设备数据存储为后续阶段（见路线图）。

## 技术栈

| 层 | 选型 |
|---|---|
| 应用框架 | uni-app（Vue3 + TS + Vite） |
| 唤醒 | App：原生插件 `app-product-wake`（sherpa-onnx KWS）；H5：Web Speech API（仅调试） |
| 音频 | 上行 16kHz / 16bit / 单声道 PCM |
| 状态机 | `core/assistant` 纯函数，可单测 |
| 配置 | 客户端本地存储 `app-product.config.v1` |
| Agent（后续） | AgentScope 2 TypeScript，跑在自建 Node 网关，不进客户端 |

## 目录

```
app-product/
├── apps/uni_app/           # 客户端
│   └── src/
│       ├── core/           # 与业务无关：状态机、唤醒、音频、配置、传输、适配
│       ├── features/       # 业务编排与页面逻辑
│       ├── pages/          # 路由页面（index / settings）
│       └── static/audio/   # 本地招呼与提示音
├── contracts/              # 客户端 ↔ 服务端消息契约
└── docs/superpowers/specs/ # 设计文档
```

## 快速开始

```bash
cd apps/uni_app
npm install
npm run dev:h5        # 浏览器，最快看到界面
npm run test          # 状态机 / 唤醒词 / 配置 单测
npm run type-check
```

App 与鸿蒙需要 HBuilderX / DevEco Studio 自定义基座，原生唤醒插件落地后才能在真机验证。详见 `apps/uni_app/README.md`。

## 配置模型

设置页按 **运行模式 → 厂商 → 参数** 三层组织：

| 层 | 说明 |
|---|---|
| 运行模式 | `byok` 自带服务（当前可用）；`platform` 平台托管（登录 + 计费后开放，付费用户免配置） |
| 厂商 | ASR：OpenAI 兼容 / 阿里云 DashScope / FunASR；LLM：OpenAI 兼容 / Ollama / DashScope / DeepSeek / AgentScope 网关；TTS：OpenAI 兼容 / Kokoro / DashScope |
| 参数 | 地址、模型、API Key、语言、音色、格式、采样率、温度、超时等，按厂商动态渲染 |

配置只保存在本机；切换厂商时各自参数保留，换回来不用重填。每张卡片支持「测试连接」与「恢复默认」。

本机已对接的参考服务：

| 服务 | 地址 | 说明 |
|---|---|---|
| openai-voice | `http://127.0.0.1:9529/v1` | OpenAI 兼容 ASR / TTS，STT `sensevoice`，TTS 支持流式 |
| kokoro-voice | `http://127.0.0.1:9530` | 本地 TTS，100 个音色，`pcm` / `wav` 流式 |
| Ollama | `http://127.0.0.1:11434` | 本地 / 云端模型，OpenAI 兼容端点为 `/v1` |

## 当前状态

- 状态机、唤醒词匹配、配置读写共 26 个单测通过，`type-check` 通过。
- H5 可用浏览器语音真实唤醒，跑通完整会话链路；后端仍为 Mock。
- App 原生唤醒桥接已就位，插件 `app-product-wake` 待实现（Android 先行）。
- ASR / LLM / TTS 直连链路尚未接入，等待代理接口细节。

## 路线图

1. 基础能力：唤醒、会话状态机、本地招呼、配置页（当前阶段）。
2. 设备控制：BLE / Wi-Fi 设备发现、配对、语音下发命令。
3. 设备数据：采集设备数据存本地；付费用户后续可同步云端。
4. 登录与计费：平台托管模式，付费用户无需配置 ASR / LLM / TTS。
5. 设备商城：App 内购买设备，形成「语音入口 → 设备控制 → 硬件收入」闭环。

## 文档

- 设计文档：`docs/superpowers/specs/2026-11-06-app-product-design.md`
- 协议契约：`contracts/README.md`
- 客户端说明：`apps/uni_app/README.md`
- 协作约定：`AGENTS.md`
