import type { TtsProvider } from './provider'

/** 占位 TTS：返回与字数大致匹配的静音 PCM，仅用于跑通下行音频链路。 */
export class StubTts implements TtsProvider {
  async *synthesize(text: string): AsyncIterable<Uint8Array> {
    const bytes = Math.max(2400, text.length * 2400)
    yield new Uint8Array(bytes)
  }
}
