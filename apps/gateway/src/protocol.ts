/**
 * 网关 ↔ 客户端的 WebSocket 语音协议类型。
 * 与仓库根目录 contracts/README.md 保持一致：文本帧走 JSON 控制消息，
 * 二进制帧走音频（客户端→服务端=麦克风 PCM 16k/16bit/mono，
 * 服务端→客户端=TTS PCM pcm16/24000），方向天然区分上下行。
 */

export type Lang = 'zh-CN'

/** 客户端 → 服务端（文本控制帧） */
export type ClientMessage =
  | { type: 'session.start'; sessionId: string; lang: Lang }
  | { type: 'session.cancel' }
  | { type: 'session.end' }

/** 服务端 → 客户端（文本控制帧），与契约一致 */
export type ServerEvent =
  | { type: 'asr.partial'; text: string }
  | { type: 'asr.final'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done' }
  | { type: 'tts.start'; format: string; sampleRate: number }
  | { type: 'tts.end' }
  | { type: 'error'; code: ServerErrorCode; message: string }

/** 契约定义的错误码 */
export type ServerErrorCode =
  | 'AUTH_FAILED'
  | 'ASR_TIMEOUT'
  | 'LLM_ERROR'
  | 'RATE_LIMITED'
  | 'SESSION_CLOSED'
