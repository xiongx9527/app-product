/** 服务端下行事件（与 contracts/README.md 保持一致） */
export type ServerEvent =
  | { type: 'asr.partial'; text: string }
  | { type: 'asr.final'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done' }
  | { type: 'tts.start'; format: string; sampleRate: number }
  | { type: 'tts.end' }
  | { type: 'error'; code: string; message: string }

/** 客户端会话传输层：真实实现走 WebSocket */
export interface AssistantTransport {
  connect(): Promise<void>
  sendAudioChunk(chunk: ArrayBuffer): void
  sendCancel(): void
  close(): void
  onEvent(listener: (event: ServerEvent) => void): () => void
  /** 下行二进制音频帧（TTS PCM）；不支持时返回空订阅函数 */
  onAudio(listener: (chunk: ArrayBuffer) => void): () => void
}
