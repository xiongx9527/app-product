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
{ "type": "session.start", "sessionId": "uuid", "lang": "zh-CN" }
{ "type": "audio.chunk", "seq": 1 }
{ "type": "session.cancel" }
{ "type": "session.end" }
```

音频二进制帧与 `audio.chunk` 二选一，最终以实现为准。

`session.start` 的 `lang` 当前仅支持 `zh-CN`：唤醒词、ASR、TTS 均为中文，客户端不做多语言切换。

服务端 → 客户端：

```json
{ "type": "asr.partial", "text": "今天" }
{ "type": "asr.final", "text": "今天天气怎么样" }
{ "type": "llm.delta", "text": "今天" }
{ "type": "llm.done" }
{ "type": "tts.start", "format": "pcm16", "sampleRate": 24000 }
{ "type": "tts.end" }
{ "type": "error", "code": "ASR_TIMEOUT", "message": "识别超时" }
```

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
