# 客户端接口契约

本目录是 Flutter / uni-app / 未来其他客户端与服务端之间的**唯一协议来源**。协议变更先改这里，再改客户端与服务端。

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

TTS 下行默认 `pcm16 / 24000 Hz`，由 `tts.start` 声明，客户端按声明解码。

## 消息

客户端 → 服务端：

```json
{ "type": "session.start", "sessionId": "uuid", "lang": "zh-CN", "timezone": "Asia/Shanghai", "location": { "latitude": 31.23, "longitude": 121.47, "address": "上海市" }, "geocode": { "provider": "tianditu", "key": "客户端天地图 tk" } }
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

`session.start` 的 `location` 为客户端设备位置（`latitude` / `longitude` 必填，`address` 为反向地理编码得到的城市/街道，由客户端提供）；缺省时由 `session.location` 消息在连接后或位置变化时补报/刷新。位置类工具（`get_current_location`）按此返回用户所处位置。

`session.start` 的 `geocode` 为客户端选择的位置服务商配置（`provider`: `tianditu` / `tencent` / `amap` + `key`），逆地理编码（坐标→地址）在网关侧据此完成；`key` 留空时退回网关兜底天地图 tk（环境变量 `TIANDITU_TK`）。三家均免费，坐标均为 GCJ-02（天地图除外，网关内部将 GCJ-02 转 WGS-84 再请求）。客户端可在设置页选择服务商并填入自有 Key（byok），不填则使用网关兜底。

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
{ "type": "error", "code": "ASR_TIMEOUT", "message": "识别超时" }
```

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

## 错误码

| code | 含义 | 客户端行为 |
|---|---|---|
| `AUTH_FAILED` | 鉴权失败 | 停止会话，提示重新登录 |
| `ASR_TIMEOUT` | 识别超时 | 提示后回到待唤醒 |
| `LLM_ERROR` | 模型异常 | 提示后回到待唤醒 |
| `RATE_LIMITED` | 限流 | 退避重试，提示稍后再试 |
| `SESSION_CLOSED` | 会话已关闭 | 清理本地状态，回到待唤醒 |

## 约束

- 所有时间戳为毫秒。
- 客户端不得依赖服务端未在本文档声明的字段。
- 新增字段必须向后兼容；删除/改名必须升版本并在 `docs/` 记录。
