# DashScope 实时语音对接文档（ASR / TTS WebSocket）

> 状态：两个 provider 已实现，`npm run type-check` 与 `npm run test` 均通过。设置页配置模型与网关接线方案已在第 4 节确定，但**代码尚未按第 4 节实施**。
> 原文件未改动：`asr/index.ts`、`tts/index.ts`、`config.ts`、`health.ts`、`voiceController.ts` 目前都保持原样；第 4 节写的是“设置页 + 网关”应该怎么改的手工清单，不是已经改好的代码。
> 适用：网关 `xiaoxiong-app/gateway`；DashScope 官方 WebSocket 入口，或完整兼容 DashScope WS 协议的代理。
> 最后更新：2026-11-09

## 1. 它是什么 / 不是什么

### 1.1 是什么

把 DashScope 的实时语音协议适配成网关已有的两个抽象：

| 文件 | 导出类 | 实现接口 |
|---|---|---|
| `src/asr/dashscopeWs.ts` | `DashScopeWsAsr` | `AsrProvider` |
| `src/tts/dashscopeWs.ts` | `DashScopeWsTts` | `TtsProvider` |

上层 `VoiceSessionService` 不需要任何改动，仍然只调用：

```ts
asr.push(pcm)       // 返回最新中间文本或 null
asr.finalize()      // 返回最终文本，并自行 reset
tts.synthesize(text) // AsyncIterable<Uint8Array>，逐帧 PCM
```

### 1.2 不是什么

这不是通用 WebSocket 语音适配器。它只认 DashScope 的报文结构：

- `run-task` / `task-started` / `continue-task` / `finish-task` / `task-finished` / `task-failed`
- `payload.task_group = "audio"`
- ASR：`payload.task = "asr"`，`function = "recognition"`
- TTS：`payload.task = "tts"`，`function = "SpeechSynthesizer"`
- `Authorization: Bearer <key>`
- 二进制帧直接是 PCM

以下厂商需要各自新增适配文件，不能直接复用：

- OpenAI Realtime（`session.update` / `input_audio_buffer`）
- Azure Speech
- 讯飞、腾讯、火山
- FunASR 原生 WebSocket
- Edge TTS

## 2. 前置条件

1. 网关侧已有 `ws` 依赖（`package.json` 已包含 `ws`、`@types/ws`）。
2. 已获取 DashScope API Key，并确认地域：
   - 华北 2（北京）：`wss://dashscope.aliyuncs.com/api-ws/v1/inference`
   - 业务空间专属：`wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
   - 新加坡：`wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference`
3. 上行音频固定为 **16kHz / 16bit / 单声道 PCM**（网关 VAD 与客户端契约）。
4. 下行音频固定为 **pcm16 / 24000Hz**（`tts.start` 已写死，不能改）。

## 3. 协议流程

### 3.1 ASR：一句一个任务

```
网关                                   DashScope
 │                                         │
 ├── WebSocket 握手（Bearer / Workspace）──▶│
 ├── run-task(streaming=duplex, task=asr)─▶│
 │◀──────────────── task-started ──────────┤
 ├── binary PCM（16k/16bit/mono）─────────▶│
 │◀──────── result-generated(sentence) ────┤  ← 中间结果 + sentence_end=true 定稿
 ├── finish-task(streaming=duplex)────────▶│
 │◀──────────────── task-finished ─────────┤
 │  close / reset                          │
```

ASR 的 `result-generated` 结构：

```json
{
  "header": { "event": "result-generated", "task_id": "..." },
  "payload": {
    "output": {
      "sentence": {
        "begin_time": 170,
        "end_time": 920,
        "text": "好，我知道了",
        "heartbeat": false,
        "sentence_end": true
      }
    }
  }
}
```

规则：

- `sentence_end = true` 才是定稿；`false` 只作为当前句的中间文本。
- `heartbeat = true` 是静音心跳，直接忽略。
- 兼容 `payload.sentence` 与 `sentence` 为数组的老版本返回。
- 同一句的最终结果可能重复下发，按 `begin_time` 覆盖，不重复追加。

### 3.2 TTS：一句一个任务

```
网关                                   DashScope
 │                                         │
 ├── WebSocket 握手（Bearer / Workspace）──▶│
 ├── run-task(streaming=duplex, task=tts)─▶│  payload.input 必须是 {}
 │◀──────────────── task-started ──────────┤
 ├── continue-task(input.text)────────────▶│
 ├── finish-task(streaming=duplex)────────▶│
 │◀──────────────── task-finished ─────────┤
 │◀════ binary PCM 音频帧（可连续） ════════┤
 │  close                                  │
```

注意：

- 文本不能放在 `run-task.input`，必须等 `task-started` 后用 `continue-task` 发送。
- `finish-task` 不能省略；服务端收到后才会强制合成缓存内容，并在最后回 `task-finished`。
- 音频是二进制帧，边收边下发，不需要等整段合成完。

## 4. 设置页与网关接线

### 4.1 配置模型

App 设置页把 ASR / LLM / TTS 合成一份「语音服务」配置：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `provider` | `'builtin' \| 'dashscope'` | `'builtin'` | 内置 = 网关当前代码；DashScope = 用户自带 |
| `url` | `string` | 内置 `http://127.0.0.1:9529`；DashScope `https://dashscope.aliyuncs.com` | 服务根地址 |
| `apiKey` | `string` | 空 | 内置通常为空；DashScope 必填 |

后续要加 `model` / `voice` 等属性时，仍放在同一个对象里，不改存储结构。**不再保留 `asr` / `llm` / `tts` 三份子配置和 `byProvider`**；切换厂商只改 `voice.provider`。

```ts
export type VoiceProviderKind = 'builtin' | 'dashscope'

export interface VoiceServiceConfig {
  provider: VoiceProviderKind
  url: string
  apiKey: string
}

export interface AppConfig {
  version: 1
  mode: ServiceMode
  language: string
  timezone: string
  voice: VoiceServiceConfig
}
```

默认值：

```ts
{
  provider: 'builtin',
  url: 'http://127.0.0.1:9529',
  apiKey: '',
}
```

### 4.2 设置页

- 删除 ASR / LLM / TTS 三张能力卡，改成一张「语音服务」卡。
- 提供商二选一：内置 / DashScope。
- URL：
  - 选内置：默认 `http://127.0.0.1:9529`，只填根地址（不要填 `/llm/v1` 或 `/voice`，网关会分别拼），可改成本机 / 局域网里的本地 AI 服务地址。
  - 选 DashScope：自动切到 `https://dashscope.aliyuncs.com`，也可填业务空间地址。
- API Key：内置隐藏；DashScope 显示密码框，默认为空。
- 模型、音色不在这里填，走第 5 节的默认值。
- 保存后提示「下次连接生效」。
- 语言 / 时区 / 长期记忆保留。
- 原来的「测试连接」按钮去掉：客户端不能直连第三方；需要测试时由网关提供接口。

### 4.3 客户端 → 网关

`session.start` 增加可选 `voice`：

```ts
type ClientMessage =
  | {
      type: 'session.start'
      // ...现有字段
      voice?: {
        provider: 'builtin' | 'dashscope'
        url: string
        apiKey?: string
      }
    }
  // ...
```

客户端在 `sendStart()` 里带上 `appConfig.voice`。旧客户端不带 `voice`，网关按内置 + env 配置处理。

### 4.4 网关：单次会话配置

新增纯函数 `resolveSessionConfig(base, voice, lang)`（建议放 `gateway/src/service/voiceSelection.ts`）：

- `voice` 缺失或 provider 非法：完全沿用网关 env（`config.llm` / `config.asr` / `config.tts`），旧客户端行为不变。
- provider 为 `builtin`：
  - 以 App 的 `url` 为准（空则用 `http://127.0.0.1:9529`）：
    - LLM：`baseUrl=${root}/llm/v1`，**`provider` 必须改成 `openai`**
    - ASR / TTS：`baseUrl=${root}/voice`
  - **两个前缀不一样，不能把同一个 OpenAI base 直接套到三件事上**：LLM 是 `/llm/v1`，ASR / TTS 是 `/voice`。
  - **LLM provider 不能沿用 env 的 `ollama`**：`ollama` 走原生 `/api/chat`，会拼成 `/llm/v1/api/chat`。内置 URL 指向本地 AI 服务时只走 OpenAI 兼容层，必须用 `openai`；只有直连 `:11434` 才用 `ollama`。
  - 模型 / 参数 / API Key 沿用网关 env（model 仍是 `LLM_MODEL`，交给本地服务转发）。
- provider 为 `dashscope`：
  - `url` 归一化成地域根；支持根地址、`/compatible-mode/v1`、`/api-ws/v1/inference` 三种写法。
  - LLM：`provider='openai'`，`baseUrl=${root}/compatible-mode/v1`，`model='qwen-plus'`
  - ASR：`provider='dashscope'`，`baseUrl=wss://host/api-ws/v1/inference`，`params={ model:'paraformer-realtime-v2', language: baseLang }`
  - TTS：`provider='dashscope'`，`baseUrl=wss://host/api-ws/v1/inference`，`params={ model:'cosyvoice-v2', voice:'longxiaochun_v2', language: baseLang }`
  - `apiKey` 三件事共用。
  - `asr.endpointMs` 沿用 base。
  - 不合并 base 里内置厂商的 params，避免把 `voice: zh-CN-XiaoxiaoNeural`、`format: mp3` 之类带进 DashScope。

内置默认值正好等于 `config.ts` 的代码默认值；如果部署时 App 里填了不同的 `url`，就以 App 的地址为准。

> 注意：内置模式会以 App 的 `url` 为准。若网关 env 仍是当前的 Ollama `127.0.0.1:11434` / 局域网 `192.168.1.100:9529`，需要把设置页的内置 URL 改成对应服务地址，或让旧客户端不带 `voice` 以沿用 env。

### 4.5 网关工厂

`config.ts`：

```diff
-export type AsrProviderKind = 'stub' | 'whisper' | 'azure' | 'aliyun' | 'xunfei'
+export type AsrProviderKind = 'stub' | 'whisper' | 'azure' | 'aliyun' | 'dashscope' | 'xunfei'
-export type TtsProviderKind = 'stub' | 'edge' | 'azure' | 'aliyun' | 'xunfei'
+export type TtsProviderKind = 'stub' | 'edge' | 'azure' | 'aliyun' | 'dashscope' | 'xunfei'
```

`asr/index.ts`：

```diff
 export { HttpVoiceAsr } from './http'
+export { DashScopeWsAsr } from './dashscopeWs'
 import type { AsrProvider } from './provider'
 import { StubAsr } from './stub'
 import { HttpVoiceAsr } from './http'
+import { DashScopeWsAsr } from './dashscopeWs'
 import type { GatewayConfig } from '../config'
 
 export function createAsr(config: GatewayConfig): AsrProvider {
-  return config.asr.provider === 'stub'
-    ? new StubAsr()
-    : new HttpVoiceAsr(config.asr.baseUrl, config.asr.params, config.asr.apiKey)
+  if (config.asr.provider === 'stub') return new StubAsr()
+  if (config.asr.provider === 'dashscope') {
+    return new DashScopeWsAsr(config.asr.baseUrl, config.asr.params, config.asr.apiKey)
+  }
+  return new HttpVoiceAsr(config.asr.baseUrl, config.asr.params, config.asr.apiKey)
 }
```

`tts/index.ts`：

```diff
 export { HttpVoiceTts } from './http'
+export { DashScopeWsTts } from './dashscopeWs'
 import type { TtsProvider } from './provider'
 import { StubTts } from './stub'
 import { HttpVoiceTts } from './http'
+import { DashScopeWsTts } from './dashscopeWs'
 import type { GatewayConfig } from '../config'
 
 export function createTts(config: GatewayConfig): TtsProvider {
-  return config.tts.provider === 'stub'
-    ? new StubTts()
-    : new HttpVoiceTts(config.tts.baseUrl, config.tts.params, config.tts.apiKey)
+  if (config.tts.provider === 'stub') return new StubTts()
+  if (config.tts.provider === 'dashscope') {
+    return new DashScopeWsTts(config.tts.baseUrl, config.tts.params, config.tts.apiKey)
+  }
+  return new HttpVoiceTts(config.tts.baseUrl, config.tts.params, config.tts.apiKey)
 }
```

LLM 不改 `agentService.ts`：DashScope 会话里用 `provider='openai'` + compatible-mode 地址，直接复用现有 `OpenAIChatModel`。

### 4.6 会话创建与复用

`voiceController.ts` 在把 `session.start` 交给 `VoiceSessionService` 之前先解析 `voice`：

1. 计算 `voiceKey = provider + '|' + url + '|' + apiKey`。
2. 同一 `deviceId` 已有会话：
   - `voiceKey` 相同：复用，保留对话记忆。
   - `voiceKey` 不同：`close()` 旧会话，从注册表移除，用新配置重建。
3. 新会话：用 `resolveSessionConfig(...)` 的结果创建 `VoiceSessionService`。
4. `sessionRegistry` 的条目增加 `voiceKey`，供下一次 `session.start` 比较。

这样切换配置后，下一次连接 / 唤醒就生效，不需要重启网关。

### 4.7 健康检查

`health.ts` 需要改三处：

1. `wss://` 地址改用 WebSocket 握手探测（见下面 diff）。
2. `buildHealth` 使用 `resolveSessionConfig` 之后的会话配置，而不是全局 env；ASR / TTS 探测带 `Authorization: Bearer <key>`。
3. DashScope LLM 探测走 `GET ${root}/compatible-mode/v1/models`，带 Key；不要用 `fetch(baseUrl)` 裸探。

```diff
+import { WebSocket } from 'ws'
 import type { GatewayConfig } from '../config'
```

```diff
+function isWsUrl(url: string): boolean {
+  return /^wss?:\/\//i.test(url)
+}
+
+async function probeWs(url: string, apiKey?: string, timeoutMs = 3000): Promise<boolean> {
+  return new Promise((resolve) => {
+    const headers: Record<string, string> = {}
+    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
+    const ws = new WebSocket(url, { headers })
+    const timer = setTimeout(() => {
+      ws.terminate()
+      resolve(false)
+    }, timeoutMs)
+    ws.once('open', () => {
+      clearTimeout(timer)
+      ws.close()
+      resolve(true)
+    })
+    ws.once('error', () => {
+      clearTimeout(timer)
+      ws.terminate()
+      resolve(false)
+    })
+  })
+}
```

`buildStatus` 增加 `apiKey`，ASR / TTS 遇到 `wss://` 时走 `probeWs`；`buildHealth` 传入会话配置的 Key。

### 4.8 兼容与迁移

- 存储 key 仍是 `app-product.config.v1`。
- `AppConfig` **只保留 `voice`**：`asr` / `llm` / `tts` 三个字段从类型、默认值和存储里直接删除，不再读取。
- 旧存档：`voice` 缺失时补默认 `{ provider: 'builtin', url: 'http://127.0.0.1:9529', apiKey: '' }`；旧的 `asr` / `llm` / `tts` 字段直接丢弃，不做迁移、不做兼容分支。
- `core/config/providers.ts`、`core/config/tester.ts` **直接删除**，连同 `CAPABILITIES` / `getProvider` / `getProviderValues` / `setProvider` / `resetCapability` 等只服务于三张能力卡的导出；设置页不再引用。
- 旧客户端 `session.start` 不带 `voice` → 网关完全沿用 env，行为不变。
- 语音接口前缀统一为 `/voice`（旧拼写 `/voide` 已废弃，**不保留别名**）；已有 `.env` 的 `ASR_BASE_URL` / `TTS_BASE_URL` 必须同步带上 `/voice`，否则 404。
- 不新增网关数据库 / REST 接口；API Key 只存在客户端本地和 WSS 文本帧里。

### 4.9 实施顺序

1. `core/config` 改成 `voice` 单对象 + 默认值 + 归一化，删除 `asr` / `llm` / `tts` 与 `providers.ts` / `tester.ts`。
2. 设置页换成一张「语音服务」卡。
3. `session.start` 加 `voice`，客户端发送。
4. 网关 `voiceSelection.ts` + `voiceController` 会话重建。
5. `config.ts` / `asr/index.ts` / `tts/index.ts` 接线。
6. `health.ts` 改 WS 探测 + 会话配置。
7. 补测试：配置归一化、URL 展开、`session.start` 路由、provider 工厂。

## 5. 配置参数

### 5.1 ASR 参数

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `model` | 否 | `paraformer-realtime-v2` | 必须是实时模型；`paraformer-v2` 是文件模型，不适用 |
| `language` | 否 | 无 | 支持 `zh`、`en`、`yue`、`ja`、`ko`、`de`、`fr`、`ru`；也接受 `zh-CN`、`zh,en` |
| `language_hints` | 否 | 无 | 优先于 `language`；数组或逗号分隔字符串 |
| `workspace` | 否 | 空 | 业务空间 ID，写入 `X-DashScope-WorkSpace` |
| 其它 | 否 | 无 | 如 `semantic_punctuation_enabled`、`max_sentence_silence`、`disfluency_removal_enabled`，原样透传 |

强制覆盖，配置里写什么都不生效：

```json
{ "format": "pcm", "sample_rate": 16000 }
```

原因：网关送给 ASR 的音频就是 16kHz/16bit/单声道 PCM。如果让配置改成 48000，服务端会按错误采样率解码，识别结果会变成乱码。

### 5.2 TTS 参数

| 参数 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `model` | 否 | `cosyvoice-v2` | 支持 cosyvoice-v1 / v2 / v3 系列 |
| `voice` | 否 | 按模型选择 | 未传时：v1 → `longxiaochun`，v2 → `longxiaochun_v2`，v3 → `longxiaochun_v3` |
| `speed` | 否 | `1` | 映射为 DashScope 的 `rate`，范围 `0.5–2.0` |
| `rate` | 否 | `1` | 直接使用，范围 `0.5–2.0` |
| `volume` | 否 | 厂商默认 | 范围 `0–100` |
| `pitch` | 否 | `1` | 范围 `0.5–2.0` |
| `language` / `language_hints` | 否 | 无 | 映射为 `language_hints`，只取基础语言码 |
| `workspace` | 否 | 空 | 业务空间 ID |
| 其它 | 否 | 无 | 如 `instruction`、`seed`、`enable_ssml`、`bit_rate`，原样透传 |

强制覆盖：

```json
{
  "text_type": "PlainText",
  "format": "pcm",
  "sample_rate": 24000
}
```

原因：`VoiceSessionService` 下发的 `tts.start` 写死了 `format: "pcm16", sampleRate: 24000`。如果厂商参数改成 mp3 或 22050，客户端会按 24k PCM 播放，导致变速、变调或直接没声音。

### 5.3 音色名兼容

客户端模板里的系统音色是 v1 命名。适配层会在 v2/v3 模型上自动补后缀：

| 配置的 voice | cosyvoice-v2 | cosyvoice-v3 |
|---|---|---|
| `longxiaochun` | `longxiaochun_v2` | `longxiaochun_v3` |
| `longxiaoxia` | `longxiaoxia_v2` | `longxiaoxia_v3` |
| `longwan` | `longwan_v2` | `longwan_v3` |

复刻音色 ID 原样透传，不补后缀。

### 5.4 地址归一化

设置页只有一个 `voice.url`，网关按 provider 展开：

**内置**

> 注意：内置服务的 LLM 与 ASR / TTS 前缀不同——LLM 是 `/llm/v1`，ASR / TTS 是 `/voice`。`voice.url` 填根地址即可，网关分别拼接；若已经带了其中一个前缀，先剥到根再拼另一个。
>
> 内置 LLM 的 `provider` 固定为 `openai`（OpenAI 兼容层），不能沿用 env 的 `ollama`；ASR / TTS 的 provider 仍按 env（如 `whisper` / `edge`），只把 baseUrl 换成 `${root}/voice`。

| `voice.url` | LLM | ASR / TTS |
|---|---|---|
| 空 | 沿用网关 env | 沿用网关 env |
| `http://127.0.0.1:9529` | `http://127.0.0.1:9529/llm/v1` | `http://127.0.0.1:9529/voice` |
| `http://192.168.1.100:9529` | `http://192.168.1.100:9529/llm/v1` | `http://192.168.1.100:9529/voice` |
| `http://127.0.0.1:9529/llm/v1` | 原样使用 | `http://127.0.0.1:9529/voice` |
| `http://127.0.0.1:9529/voice` | `http://127.0.0.1:9529/llm/v1` | 原样使用 |

**DashScope**

| `voice.url` | LLM | ASR / TTS |
|---|---|---|
| 空 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `wss://dashscope.aliyuncs.com/api-ws/v1/inference` |
| `https://dashscope.aliyuncs.com` | 同上 | 同上 |
| `https://dashscope.aliyuncs.com/api/v1` | 同上 | 同上 |
| `https://dashscope.aliyuncs.com/compatible-mode/v1` | 原样使用 | 按 host 展开成 `wss://.../api-ws/v1/inference` |
| `wss://dashscope.aliyuncs.com/api-ws/v1/inference` | 按 host 展开成 `https://.../compatible-mode/v1` | 原样使用 |
| `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com` | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference` |

## 6. 运行时行为

### 6.1 ASR

| 行为 | 说明 |
|---|---|
| 懒建连 | 第一帧音频到达才建 WS；空闲会话不占连接 |
| 连接前缓存 | 建连期间最多缓存最近 30 秒音频（16k×2×30 字节） |
| 启动超时 | 8 秒内没收到 `task-started` 就放弃本句 |
| 定稿超时 | 发出 `finish-task` 后最多等 8 秒 `task-finished` |
| 部分结果 | `push()` 返回“最新的中间文本”，没变化返回 `null` |
| 定稿 | `finalize()` 返回累计文本，并自动 `reset()` |
| 失败兜底 | 建连 / 定稿失败时返回已经拿到的中间结果，不让会话卡死 |
| task-failed | 标记本句失败，不再重连、不再补发 `finish-task` |
| 连接粒度 | 一句一个连接；句末关闭 |

`finalize()` 的空音频短路：如果这一轮没有任何上行音频（例如 VAD 只切出了静音），不会建连，直接返回空字符串。

### 6.2 TTS

| 行为 | 说明 |
|---|---|
| 流式 | 收到一帧二进制就 `yield` 一帧，客户端可以边收边播 |
| 空闲超时 | 15 秒没有收到任何下行消息就终止本次任务 |
| 文本上限 | 单次最多 20000 字符，超出截断 |
| 失败兜底 | 只有“一帧音频都没收到”才补静音；已经收到部分音频就让这句自然结束，避免重复出声 |
| 连接粒度 | 一句一个连接；句末关闭 |

官方建议复用 WebSocket 连接处理多个任务。当前实现选择一句一连接，原因是会话本来就是按句调用 `synthesize()`，句末关闭最省状态，也不会让上一句的残留音频串到下一句；代价是每句多一次握手。

## 7. 错误处理

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 握手失败 401/403 | API Key 错误、地域不匹配、Key 与 Workspace 不匹配 | 检查 `ASR_API_KEY` / `TTS_API_KEY` 和 baseUrl 地域 |
| `task-failed` + `Model not found` | 模型名拼错，或用了文件模型 | ASR 用 `paraformer-realtime-v2`；TTS 用 `cosyvoice-v2` |
| `task-failed` + `voice not found` | 音色与模型版本不匹配 | 用 `longxiaochun_v2`，或交给音色自动补后缀 |
| `task-failed` + `request timeout after 23 seconds` | 长时间没发音频 / 没发 `finish-task` | 当前实现会在句末立即发 `finish-task`；检查网络是否卡住 |
| ASR 识别为空 / 乱码 | 上行不是 16k/16bit/单声道，或采样率配置被改 | 已强制 `sample_rate=16000`；检查客户端上行格式 |
| TTS 没声音 | 音色不存在、任务失败、客户端没按 24k PCM 播放 | 看 `[tts] DashScope WebSocket 合成失败` 日志；确认 `tts.start` 声明 |
| 声音变速 / 变调 | 下行采样率不是 24000 | 已强制 `sample_rate=24000`；检查客户端播放器 |
| 设置页显示不可达 | `health.ts` 仍用 HTTP 探测 `wss://` | 按 4.7 加 WS 探测 |

日志前缀：

- ASR：`[asr] DashScope WebSocket 建连失败`、`[asr] DashScope 任务失败`、`[asr] DashScope WebSocket 定稿失败`
- TTS：`[tts] DashScope WebSocket 合成失败`

## 8. 验证

### 8.1 静态检查

```bash
cd xiaoxiong-app/gateway
npm run type-check
npm run test
```

当前基线：`type-check` 零报错；`test` 20 个文件、244 个用例全绿。

### 8.2 本地 WS mock 冒烟

仓库里没有常驻的 mock 脚本，需要时可按下面要点临时验证：

1. ASR
   - 校验握手 `Authorization: Bearer ...`
   - 校验 `run-task.header.streaming === 'duplex'`
   - 校验 `payload.task === 'asr'`、`function === 'recognition'`
   - 校验 `parameters.format === 'pcm'`、`sample_rate === 16000`
   - 服务端回 `task-started` → 客户端发二进制 PCM → 回 `result-generated` → 回 `task-finished`
   - 校验 `finish-task.header.streaming === 'duplex'`
2. TTS
   - 校验 `run-task.payload.input` 是 `{}`
   - 校验 `task === 'tts'`、`function === 'SpeechSynthesizer'`
   - 校验 `text_type === 'PlainText'`、`format === 'pcm'`、`sample_rate === 24000`
   - `task-started` 后应收到 `continue-task`，再收到 `finish-task`
   - 服务端发二进制帧后，客户端应逐帧 `yield`

### 8.3 真实环境验收

1. 启动网关，确认 `/api/health` 中 ASR/TTS 为可达（先按 4.7 处理 WS 探测）。
2. 客户端唤醒「小熊小熊」，说一句话。
3. 网关日志应出现正常的 `task-started` → 识别结果 → `task-finished`，不应有 `task-failed`。
4. 助手回复时，客户端应能流式播放，且语速/音调正常。
5. 断网或 Key 错误时，会话不应卡死：ASR 返回已有中间结果，TTS 回退静音。

## 9. 边界与后续

- **只支持 DashScope 协议**：其它厂商需要新增 `xxxWs.ts`，不要往 `dashscopeWs.ts` 里堆分支。
- **一句一连接**：后续如果要降低握手开销，可以改成连接池 / 连接复用；需要处理 task_id、残留音频和取消语义。
- **health.ts 按 4.7 接线**：不改会让设置页把 DashScope 误报为不可达。
- **没有常驻单测**：WS 适配层目前靠 type-check + 全量测试 + 临时 mock 冒烟验证；如果后续要长期维护，可以补 `dashscopeWs.test.ts`，用本地 `WebSocketServer` 覆盖正常流程、`task-failed`、超时三条路径。
