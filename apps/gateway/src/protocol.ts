/**
 * 网关 ↔ 客户端的 WebSocket 语音协议类型。
 * 与仓库根目录 contracts/README.md 保持一致：文本帧走 JSON 控制消息，
 * 二进制帧走音频（客户端→服务端=麦克风 PCM 16k/16bit/mono，
 * 服务端→客户端=TTS PCM pcm16/24000），方向天然区分上下行。
 */

export type Lang = 'zh-CN'

/** 客户端 → 服务端（文本控制帧） */
export type ClientMessage =
  | {
      type: 'session.start'
      sessionId: string
      lang: Lang
      /** wake=只做 ASR（用于本地唤醒词检测，不跑 LLM/TTS）；dialog=完整对话，默认 */
      mode?: 'wake' | 'dialog'
    }
  | { type: 'session.cancel' }
  | { type: 'session.end' }
  /** 客户端本地播放队列清空后回执：网关据此才消费排队的下一句 */
  | { type: 'session.playback_done' }

/** 服务端 → 客户端（文本控制帧），与契约一致 */
export type ServerEvent =
  | { type: 'asr.partial'; text: string }
  /** queueRemaining=网关队列此刻还剩几句；由服务端给出，客户端据此同步而不靠猜测 */
  | { type: 'asr.final'; text: string; queueRemaining: number }
  /** 当前轮还没播完，这句只识别不回复，按序排队等本轮结束 */
  | { type: 'asr.queued'; text: string; position: number; size: number; message: string }
  /** 这句没有被接收，message 为按 lang 本地化的原因 */
  /** reason 标记「队列满」拒收，客户端据此在固定提示区展示专用话术 */
  | { type: 'asr.rejected'; text: string; message: string; reason: 'queue-full' }
  | { type: 'llm.thinking'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done' }
  | { type: 'tts.start'; format: string; sampleRate: number }
  | { type: 'tts.stop' }
  | { type: 'tts.end' }
  /** half=回声兜底中，播报期间不拾音，用户需点「打断」；full=正常全双工 */
  | { type: 'audio.duplex'; mode: 'half' | 'full' }
  | { type: 'error'; code: ServerErrorCode; message: string }

/** 契约定义的错误码 */
export type ServerErrorCode =
  | 'AUTH_FAILED'
  | 'ASR_TIMEOUT'
  | 'LLM_ERROR'
  | 'RATE_LIMITED'
  | 'SESSION_CLOSED'
