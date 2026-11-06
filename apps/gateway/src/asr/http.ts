import type { AsrProvider } from './provider'
import type { VendorParams } from '../config'

/**
 * 对接本地语音服务（openai-voice，OpenAI 兼容）的 ASR。
 *
 * 实际接口：POST {baseUrl}/v1/audio/transcriptions（multipart/form-data）
 *   - file: WAV 音频（SenseVoice 后端要求 RIFF/WAV，纯 PCM 会报 "does not start with RIFF id"）
 *   - model: whisper-1（服务忽略，后端由 STT_BACKEND 决定）
 *   - language: 可选，如 zh
 *   返回 JSON { text }。
 *
 * 网关上行是 16kHz/16bit/单声道 PCM，这里在 finalize 时补 44 字节 WAV 头再提交。
 * 调用失败不抛异常，回退占位文本，保证会话不中断。
 */
export class HttpVoiceAsr implements AsrProvider {
  private buffer: Buffer[] = []

  constructor(
    private readonly baseUrl: string,
    private readonly params: VendorParams = {},
    private readonly apiKey = '',
  ) {}

  async push(chunk: Uint8Array): Promise<string | null> {
    this.buffer.push(Buffer.from(chunk))
    return null
  }

  async finalize(): Promise<string> {
    if (this.buffer.length === 0) return ''
    const pcm = Buffer.concat(this.buffer)
    this.buffer = []
    try {
      const sampleRate = Number(this.params.sampleRate ?? 16000)
      const wav = pcmToWav(pcm, Number.isFinite(sampleRate) ? sampleRate : 16000)
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
      form.append('model', String(this.params.model ?? 'whisper-1'))
      if (this.params.language !== undefined) {
        form.append('language', String(this.params.language))
      }
      const res = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: this.authHeaders({}),
        body: form,
      })
      const text = await res.text()
      try {
        const parsed = JSON.parse(text) as { text?: string }
        return typeof parsed.text === 'string' ? parsed.text : text
      } catch {
        return text
      }
    } catch (err) {
      console.error('[asr] 调用本地语音服务失败，回退占位文本：', err)
      return '（ASR 服务暂不可用）'
    }
  }

  reset(): void {
    this.buffer = []
  }

  /** 统一附加鉴权头：有 apiKey 时带 Bearer，否则原样返回。 */
  private authHeaders(headers: Record<string, string>): Record<string, string> {
    return this.apiKey ? { ...headers, Authorization: `Bearer ${this.apiKey}` } : headers
  }
}

/** 给 16bit 单声道 PCM 补 44 字节 WAV 头。 */
function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}
