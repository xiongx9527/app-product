/**
 * TTS（语音合成）抽象：把文本合成为 pcm16 / 24000Hz 的音频帧流，
 * 由网关以二进制帧下发给客户端。
 */
export interface TtsProvider {
  /** signal 用于取消在途合成：插话/打断时立即中止，避免白跑到超时打满后端。 */
  synthesize(text: string, signal?: AbortSignal): AsyncIterable<Uint8Array>
}
