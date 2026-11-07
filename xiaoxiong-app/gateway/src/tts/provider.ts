/**
 * TTS（语音合成）抽象：把文本合成为 pcm16 / 24000Hz 的音频帧流，
 * 由网关以二进制帧下发给客户端。
 */
export interface TtsProvider {
  synthesize(text: string): AsyncIterable<Uint8Array>
}
