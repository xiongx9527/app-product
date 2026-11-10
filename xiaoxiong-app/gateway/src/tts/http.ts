import type { TtsProvider } from './provider'
import type { VendorParams } from '../config'

/**
 * 对接本地语音服务（openai-voice，OpenAI 兼容）的 TTS。
 *
 * 实际接口：POST {baseUrl}/v1/audio/speech
 * baseUrl 默认是本地 AI 服务的 /voice。
 *   body = { input, voice, response_format: 'wav', speed, ...params }
 *   返回 WAV（16bit / 24kHz / 单声道），与本网关 tts.start 声明的 pcm16@24000 一致，
 *   因此只需剥掉 WAV 头，把 data 段原始 PCM 直接下发，无需重采样。
 *
 * params 里的厂商级参数（voice / speed 等）会合并进请求体并覆盖默认值。
 * 调用失败回退静音，保证会话不中断。
 */
export class HttpVoiceTts implements TtsProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly params: VendorParams = {},
    private readonly apiKey = '',
  ) {}

  async *synthesize(text: string): AsyncIterable<Uint8Array> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          input: text,
          voice: 'zh-CN-XiaoxiaoNeural',
          response_format: 'wav',
          speed: 1.0,
          ...this.params,
        }),
      })
      if (!res.ok || !res.body) {
        yield* this.silence(text)
        return
      }
      const contentType = res.headers.get('content-type') ?? ''
      const ab = new Uint8Array(await res.arrayBuffer())
      if (contentType.includes('application/json') || !isRiff(ab)) {
        yield* this.silence(text)
        return
      }
      const pcm = extractWavData(ab)
      yield pcm.length > 0 ? pcm : silenceBytes(text)
    } catch (err) {
      console.error('[tts] 调用本地语音服务失败，回退静音：', err)
      yield* this.silence(text)
    }
  }

  private async *silence(text: string): AsyncIterable<Uint8Array> {
    yield silenceBytes(text)
  }

  /** 统一附加鉴权头：有 apiKey 时带 Bearer，否则原样返回。 */
  private authHeaders(headers: Record<string, string>): Record<string, string> {
    return this.apiKey ? { ...headers, Authorization: `Bearer ${this.apiKey}` } : headers
  }
}

/** 静音帧长度：约按文本长度估，最短 0.1s（24kHz/16bit 单声道 = 48000 B/s）。 */
function silenceBytes(text: string): Uint8Array {
  const bytes = Math.max(4800, text.length * 4800)
  return new Uint8Array(bytes)
}

function isRiff(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 // F
  )
}

/** 解析 WAV，返回 data 段的原始 PCM；找不到 data 段时返回空。 */
function extractWavData(wav: Uint8Array): Uint8Array {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id =
      String.fromCharCode(wav[offset], wav[offset + 1], wav[offset + 2], wav[offset + 3])
    const size = dv.getUint32(offset + 4, true)
    const dataStart = offset + 8
    if (id === 'data') {
      return wav.slice(dataStart, Math.min(dataStart + size, wav.length))
    }
    // 流式 WAV 可能写 0xffffffff 表示未知长度，此时直接取剩余全部
    if (size === 0xffffffff) {
      return wav.slice(dataStart)
    }
    offset = dataStart + size + (size % 2)
  }
  return new Uint8Array(0)
}
