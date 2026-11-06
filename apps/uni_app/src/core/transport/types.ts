/** 服务端下行事件（与 contracts/README.md 保持一致） */
export type ServerEvent =
  | { type: 'asr.partial'; text: string }
  | { type: 'asr.final'; text: string }
  /** 当前轮还没播完，这句只识别不打断，排进队列 */
  | { type: 'asr.queued'; text: string; position: number; size: number; message: string }
  /** 这句没被接收（队列满），message 是服务端本地化的原因 */
  | { type: 'asr.rejected'; text: string; message: string }
  | { type: 'llm.thinking'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done' }
  | { type: 'tts.start'; format: string; sampleRate: number }
  | { type: 'tts.stop' }
  | { type: 'tts.end' }
  | { type: 'audio.duplex'; mode: 'half' | 'full' }
  | { type: 'error'; code: string; message: string }

export type SessionMode = 'wake' | 'dialog'

/** 客户端会话传输层：真实实现走 WebSocket */
export interface AssistantTransport {
  /** 建立连接并按模式开启会话（wake=只做识别用于唤醒词检测） */
  connect(mode?: SessionMode): Promise<void>
  /** 在当前连接上切换会话模式（重新下发 session.start） */
  startSession(mode: SessionMode): void
  /** 连接是否仍可用：网关重启后本地标志会过期，必须以此为准 */
  isConnected(): boolean
  sendAudioChunk(chunk: ArrayBuffer): void
  sendCancel(): void
  /** 本地播放队列真正清空后回执，网关据此才消费排队的下一句 */
  notifyPlaybackDone(): void
  close(): void
  onEvent(listener: (event: ServerEvent) => void): () => void
  /** 下行二进制音频帧（TTS PCM）；不支持时返回空订阅函数 */
  onAudio(listener: (chunk: ArrayBuffer) => void): () => void
}
