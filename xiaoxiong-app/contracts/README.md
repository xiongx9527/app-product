# 客户端接口契约

本目录是 uni-app / 未来其他客户端与服务端之间的**唯一协议来源**。协议变更先改这里，再改客户端与服务端。

> 网关（`xiaoxiong-app/gateway`）是客户端**唯一**允许通信的后端。前端不得直接调用第三方服务，所有数据读写都走这里。接口同时提供 Swagger 文档：`/docs`（可视化）、`/api/openapi.json`。

## 传输

- WebSocket 长连接。
- 心跳间隔建议 15s，服务端 45s 无心跳视为断开。
- 断线重连指数退避：1s / 2s / 4s / 8s，上限 30s。
- 一次连接可承载多轮会话。

## 音频

| 项 | 值 |
|---|---|
| 上行采样率 | 16000 Hz |
| 位深 | 16 bit |
| 声道 | 1（mono） |
| 分片 | 20–40 ms |
| 编码 | PCM（后续可切 Opus） |

上行采集按端分流（都是只读启动、用户开启助手时才开始，不在建连时占用麦克风）：

- **App（Android / iOS，目标端）**：`app-product-wake` 原生插件的 `startPcm({ sampleRate:16000, channels:1, bitsPerSample:16, frameMs:32 })` → `onPcmFrame` 回调 `ArrayBuffer` 帧直接上行；`stopPcm()` 停止。由原生层用 Android `AudioRecord` / iOS `AVAudioEngine` 直接吐 PCM。插件未落地时 `isAppCaptureSupported()` 为 false，客户端明确提示「不支持录音采集」，不静默假装能唤醒。
- **H5（仅开发阶段调试用）**：`navigator.mediaDevices.getUserMedia` + WebAudio `ScriptProcessor`，每帧 4096 采样转 16bit PCM 上行。
- 微信小程序与 HarmonyOS 确定不支持，不提供采集实现。
- **不用 `uni.getRecorderManager`**：它只录成文件（`onStop` 才给路径），且 App 端不支持 `onFrameRecorded`，无法提供 20–40ms 的持续分片；其 `format` 虽支持 `aac/mp3/wav/PCM`，但那是文件封装，不是实时流。

TTS 下行默认 `pcm16 / 24000 Hz`，由 `tts.start` 声明，客户端按声明解码。

## 消息

客户端 → 服务端：

```json
{ "type": "session.start", "sessionId": "uuid", "lang": "zh-CN", "timezone": "Asia/Shanghai", "location": { "latitude": 31.23, "longitude": 121.47, "address": "上海市" } }
{ "type": "audio.chunk", "seq": 1 }
{ "type": "session.cancel" }
{ "type": "session.end" }
{ "type": "session.location", "latitude": 31.23, "longitude": 121.47, "address": "上海市" }
{ "type": "session.playback_done" }
```

音频二进制帧与 `audio.chunk` 二选一，最终以实现为准。

`session.playback_done` 是客户端在**本地播放队列真正清空**后发给网关的回执。
`tts.end` 只代表服务端音频帧下发完毕，不代表播完；**队列还有下一句时**网关必须等
这个回执才消费，否则新一轮 `tts.start` 会掐掉上一轮还没播完的音频。
队列为空时不等回执，立刻释放，避免用户下一句被误排队。
网关同时按已下发音频时长设超时兜底，客户端没回执也不会把队列卡死。

`session.start` 的 `lang` 当前仅支持 `zh-CN`：唤醒词、ASR、TTS 均为中文，客户端不做多语言切换。

`session.start` 的 `timezone` 为客户端本地 IANA 时区（如 `Asia/Shanghai`），时间类工具据此返回用户所在时区的时间；缺省或非法时网关退回东 8 区（`Asia/Shanghai`）。客户端默认东 8 区，可在设置页修改。

`session.start` 的 `location` 为客户端设备位置（`latitude` / `longitude` 必填，`address` 为系统定位回调附带的城市/街道，可选）；缺省时由 `session.location` 消息在连接后或位置变化时补报/刷新。位置类工具（`get_current_location`）直接基于客户端上报的经纬度与可选地址返回用户所处位置，网关**不做逆地理编码**、不依赖任何地图服务商。

`session.start` 的 `deviceId` 为客户端持久化的稳定设备标识（首次生成、之后复用；同时随 WS 连接 URL query 上报为主路径）。网关据此**把会话与连接解耦**，按 `deviceId` 维护进程内会话注册表：

- **同一 `deviceId` 的「再次 `session.start`」（重唤醒/断线重连）走「重新武装」**：不重建 LLM 智能体、不清空 `pendingCandidates`（候选歌单）与对话历史、不新建会话记录行，只复位在途轮次与播放/回声状态。目标：助手在重唤醒/重连后**不丢失上下文记忆**（用户反馈的"很失忆"根因即会话被绑死在连接生命周期上）。
- **`session.end` 才是真正结束会话**：从注册表移除、销毁对话记忆，之后同一 `deviceId` 的 `session.start` 视为全新会话。
- **未上报 `deviceId`（旧客户端）**：每连接独立会话、不复用，行为同改造前，向后兼容。
- 范围：仅保证**一次网关进程内**的多轮记忆；网关重启 = 会话自然结束，跨重启持久化需落库，另行规划。

音乐播放为网关内置能力，**不再由客户端配置**：`session.start` 不含 `music` 字段。网关始终注册音乐工具（`play_music` / `stop_music` / `pause_music` / `resume_music` / `next_music`），按请求类型自动分流——
- 风格/氛围请求（轻音乐/电子/爵士…）→ SomaFM 免费电台（直接 mp3 流，无需 Key）；
- 具体歌名/歌手请求 → B 站原生搜索 API 兜底（WBI 签名），命中视频后抽取音轨返回可播放直链（视频也能播放）。

两边都搜不到时，工具明确告知「没找到这首歌」，绝不退回随机电台（避免乱播放）。B 站直链带防盗链，由网关 `/music/stream` 代理转发给客户端。

服务端 → 客户端：

```json
{ "type": "asr.partial", "text": "今天" }
{ "type": "asr.final", "text": "今天天气怎么样", "queueRemaining": 0 }
{ "type": "asr.queued", "text": "那明天呢", "position": 1, "size": 3, "message": "已排到第 1 句（共 3 句）…" }
{ "type": "asr.rejected", "text": "还有后天", "message": "排队已满（最多 3 句）…" }
{ "type": "llm.thinking", "text": "用户想知道天气，" }
{ "type": "llm.delta", "text": "今天" }
{ "type": "llm.done" }
{ "type": "tts.start", "format": "pcm16", "sampleRate": 24000 }
{ "type": "tts.stop" }
{ "type": "tts.end" }
{ "type": "audio.duplex", "mode": "half" }
{ "type": "media.play", "url": "https://ice6.somafm.com/groovesalad-128-mp3", "title": "Groove Salad（轻电子/氛围）", "channel": "groovesalad" }
{ "type": "media.play", "url": "https://.../track.m4s", "title": "稻香", "channel": "bilibili", "loop": 3 }
{ "type": "media.stop" }
{ "type": "media.lyrics", "title": "七里香", "artist": "周杰伦", "lyrics": "窗外的麻雀…" }
{ "type": "client.location.request" }
{ "type": "error", "code": "ASR_TIMEOUT", "message": "识别超时" }
```

`media.play` 让客户端用**独立播放器**播放一段音频流（电台/歌曲），与 TTS 的音频播放互不冲突；`media.stop` 停止当前播放。客户端在 TTS 播报期间应压低（duck）音乐音量，播完恢复。`media.lyrics` 携带歌词文本供客户端在页面展示。音乐只在用户要求时播放，不做预约/定时播放。

`media.play` 可带可选字段 `loop`（正整数，缺省/1 表示不循环）：客户端播完最后一遍后自动重播同一首直到达到总遍数；播完最后一遍进入「已播放完毕」态（暂停按钮变为「继续播放」按钮）。`loop>1` 时客户端在自己内部循环，不回服务端重新检索。

`client.location.request`：服务端**仅在位置/天气类工具被调用但本会话尚无设备位置时才下发**，客户端据此请求定位授权（manifest 已声明权限）并通过 `session.location` 上报经纬度。不在建连时主动要位置，避免冷启动就弹定位授权框打扰用户；用户没问位置相关问题时完全不触发定位。客户端若已授权/取不到位置则静默跳过，不阻断会话。

`asr.partial` 是网关对已收音频的滚动重识别结果，可重复、可回退，客户端只用于展示；
`asr.final` 才是定稿文本。**只有 `asr.final` 之后才会请求大模型**，中间结果不会触发回复。
`queueRemaining` 是服务端队列此刻剩余的句数（权威值）：大于 0 时客户端必须把「你说」
锁在当前句，直到这些排队句被逐个消费完，避免中间结果或下一句把当前句顶掉。

`llm.thinking` 是模型的思考过程，仅用于界面展示，不进入回复正文、不参与 TTS；
客户端可丢弃，丢弃不影响对话。

`tts.stop` 表示被打断：客户端要立刻丢弃已排队/正在播的音频；`tts.end` 只表示本轮下发完毕。

打断规则：一轮还没结束（思考或回复中）时用户又开口，**不打断当前轮**；
网关只做识别并把这句放入队列（最多 3 句），当前轮播完后按序再交给大模型，
消费队首时同样下发 `asr.final`。队列已满则下发 `asr.rejected`，
`message` 是本地化的拒收原因，客户端在页面固定区域展示，不用浮层。
客户端主动点「打断」仍走 `session.cancel`，会清空队列。

回声与杂音：网关在播报期间用 strict VAD、下行帧能量门控、已播文本比对三层
把「收回来的自己的声音」在进 ASR 之前拦掉；ASR 定稿后还会过滤极短的
环境杂音幻觉文本，以及**不属于当前 `lang` 的文字**（此时下发 `asr.rejected`，
`message` 提示用户去设置里切换语言）。送进 TTS 的文本会剥掉 markdown / emoji /
特殊符号，只保留可朗读内容；界面展示的仍是 LLM 原文。

回声兜底：浏览器 AEC 失效时，助手会被自己的回声反复打断。网关连续检测到
「紧跟播报的打断」后下发 `audio.duplex: half`，此后**播报期间不拾音**，
用户改用「打断」按钮；冷却结束自动恢复并下发 `audio.duplex: full`。
客户端收到 `half` 时应在界面上说明，避免用户以为语音失灵。

## 错误码（语音链路）

| code | 含义 | 客户端行为 |
|---|---|---|
| `AUTH_FAILED` | 鉴权失败 | 停止会话，提示重新登录 |
| `ASR_TIMEOUT` | 识别超时 | 提示后回到待唤醒 |
| `LLM_ERROR` | 模型异常 | 提示后回到待唤醒 |
| `RATE_LIMITED` | 限流 | 退避重试，提示稍后再试 |
| `SESSION_CLOSED` | 会话已关闭 | 清理本地状态，回到待唤醒 |

---

## REST 数据接口

> 语音 WebSocket 协议见上文，本节只覆盖 REST 数据接口。

### 通用约定

- Base：网关地址，如 `http://<host>:<port>`。
- 数据格式：`application/json`。
- 参数加密：由网关开关 `PARAM_ENCRYPT` 控制。开启时，`/api/*` 的请求体/响应体为密文（见下文），关闭时为明文 JSON。例外：`/api/openapi.json`（Swagger 契约文档）始终明文返回——它是公开文档，且浏览器里的 Swagger UI 没有解密能力，加密后页面无法渲染。
- 数据库只在网关落地（SQLite），客户端经这些接口读写，不直接写业务数据。

### 端点

#### GET /api/health
健康检查。

- 响应 `200`：`{ "ok": true }`

#### GET /static/cues/<name>.mp3
「能力/权限不可用」提示音文件（网络 / ASR / TTS / LLM 未就绪、或麦克风未授权时客户端从网关拉取播放）。
定位是非必须能力，只显示状态、不播提示音。

- 允许的名字（白名单，其余 404）：`network-down` / `asr-down` / `tts-down` / `llm-down` / `mic-denied`。
- 响应 `200`：`audio/mpeg`；带 `access-control-allow-origin: *`（供 H5 跨端口加载）与 `cache-control: public, max-age=3600`。
- 路径含 `..` 或非白名单名字一律 `404`。
- 客户端优先从网关拉取，拉取失败时回退到打包内的 `static/audio/<name>.mp3`。

#### 会话记录 sessions

- `POST /api/sessions`：新建一条会话记录。
  - body：`{ "deviceId": string?, "startedAt": number? }`
  - 响应 `201`：`{ "id": number }`
- `GET /api/sessions?deviceId=xxx`：列出会话（按 id 倒序，最多 100）。
  - 响应 `200`：数组，元素含 `id / device_id / started_at / ended_at / created_at`。

#### 设备数据 device-data

- `POST /api/device-data`：写入一条设备数据。
  - body：`{ "type": string, "payload": object }`
  - 响应 `201`：`{ "id": number }`
- `GET /api/device-data?deviceId=xxx`：列出（倒序，最多 200）。

#### 命令日志 command-logs

- `POST /api/command-logs`：写入一条命令日志。
  - body：`{ "command": string, "result": string }`
  - 响应 `201`：`{ "id": number }`
- `GET /api/command-logs?deviceId=xxx`：列出（倒序，最多 200）。

#### 长期记忆 memories

设备维度的用户长期记忆（习惯 / 偏好 / 作息 / 日程等），只存本机 SQLite，按 `deviceId` 隔离，不上云、不跨设备同步。同设备下 `(device_id, key)` 唯一，重复写同一 `key` 覆盖更新。

- `GET /api/memories?deviceId=xxx`：列出该设备全部记忆（按最近更新倒序），每项为 `{ "key": string, "value": string, "updatedAt": number }`。缺 `deviceId` 返回 `400`。
- `DELETE /api/memories?deviceId=xxx`（body `{ "key"?: string }`）：删除记忆。`key` 缺省或空串表示清空该设备全部记忆；否则按「话题/内容」模糊匹配（命中 `key` 等于、包含，或 `value` 包含）删除。响应 `{ "deleted": number }`。

> 语音侧的「记住 / 回忆 / 忘了XX」由对话智能体的 `remember` / `recall` / `forget` 工具与「忘了XX / 清空记忆」直接指令处理（见 `gateway/src/service/memoryControl.ts` 与 `tools/memoryTool.ts`），写入同样落到本接口背后的 `user_memory` 表。设置页（`uni_app` 的 `pages/settings`）可调 REST 查看与删除。

#### 参数加密（PARAM_ENCRYPT=true）

非对称 + 混合加密（**不是**单密钥对称方案）。前后端各持一对 RSA-2048 公私钥（共 2 对）：

- **请求方向（前端 → 后端）**：前端用「后端 RSA 公钥」加密，后端用「后端 RSA 私钥」解密。
- **响应方向（后端 → 前端）**：后端用「前端 RSA 公钥」加密，前端用「前端 RSA 私钥」解密。

RSA 只能加密小块数据，故采用混合加密：每次随机生成 `AES-256-GCM` 会话密钥加密业务数据，再用 RSA 公钥加密该会话密钥，三者封装为如下 JSON「信封」（字段均为 base64）：

```json
{ "k": "<RSA 加密后的会话密钥>", "iv": "<GCM 初始向量>", "t": "<GCM 认证标签>", "d": "<GCM 密文(不含 tag)>" }
```

- 请求：`POST/PUT` 的 HTTP body 直接是该信封 JSON 字符串（不再包业务 JSON）。
- 响应：`{ "encrypted": true, "data": "<信封 JSON 字符串>" }`，前端用「前端 RSA 私钥」解开信封得到原本的 JSON body。

密钥由 dev 脚本一次性随机生成（`scripts/dev-server.mjs` 生成到 `.rsa-keys.json` 并分别注入两端的环境变量：前端 `VITE_RSA_FRONTEND_PRIVATE_KEY` / `VITE_RSA_BACKEND_PUBLIC_KEY`，后端 `RSA_BACKEND_PRIVATE_KEY` / `RSA_FRONTEND_PUBLIC_KEY`），**两套半钥必须来自同一生成结果**，否则解密失败。关闭时（默认）均为明文 JSON，便于开发与调试。

### 错误码（REST 层）

REST 层失败返回对应 HTTP 状态；语音链路错误见上文的 `error` 事件。

## 约束

- 所有时间戳为毫秒。
- 客户端不得依赖服务端未在本文档声明的字段。
- 新增字段必须向后兼容；删除/改名必须升版本并在 `docs/` 记录。
