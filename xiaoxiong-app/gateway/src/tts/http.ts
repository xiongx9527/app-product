import type { TtsProvider } from './provider'
import type { VendorParams } from '../config'

/** 单次合成的硬超时：上游慢/挂起时主动 abort 断开、抛错走 tts-error 提示。
 *  设备经 adb reverse 访问本机 9529，偶发网络抖动会让短句也超时（实测"比如放首歌、"
 *  6字也 aborted）；8s 偏紧，放宽到 12s 减少误报，但仍小于 speakSentence 的帧间隔
 *  15s，避免两处超时竞态导致重复提示。 */
const TTS_TIMEOUT_MS = 12000
/** TTS 单帧大小：9600B = 200ms @24k/16bit。整段 TTS（builtin/deepseek 一次返回完整
 *  WAV）切成此尺寸逐帧下发——单帧 1.2MB（base64 1.6MB）经 weex 桥传输会超限/截断
 *  导致播不出来（真机"今天天气怎么样"文字出了没声音的根因）。 */
const TTS_FRAME_BYTES = 9600

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
          // 不写死 edge 音色：9529 按当前 TTS_PROVIDER 选默认音色（builtin→XiaoxiaoNeural、
          // deepseek→stella）。写死 edge 音色会让 deepseek 分支拒绝（502）导致播不出来。
          // 客户端显式配了 voice（params.voice）才覆盖。
          response_format: 'wav',
          speed: 1.0,
          ...this.params,
        }),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      })
      if (!res.ok || !res.body) {
        // 失败必须显式抛错，让 speakSentence 的 catch 发 tts-error 本地 mp3 提示。
        // 旧实现回退静音帧：网关收到"帧"就当成功，既不播声音也不播提示（用户"失败了没提示"）。
        throw new Error(`[tts] 合成失败 HTTP ${res.status}`)
      }
      const contentType = res.headers.get('content-type') ?? ''
      const ab = new Uint8Array(await res.arrayBuffer())
      if (contentType.includes('application/json') || !isRiff(ab)) {
        throw new Error('[tts] 合成失败：响应非 WAV')
      }
      const pcm = extractWavData(ab)
      if (pcm.length === 0) throw new Error('[tts] 合成失败：WAV 无 data 段')
      // 整段 TTS（builtin/deepseek 一次返回完整 WAV）必须切成小帧下发：
      // 原生 playPcm(String b64) 每帧 Base64.decode 后写 AudioTrack，单帧 1.2MB（base64 1.6MB）
      // 经 weex 桥传输会超限/截断 → 播不出来。切成 9600B(200ms@24k) 匹配流式播放。
      for (let off = 0; off < pcm.length; off += TTS_FRAME_BYTES) {
        yield pcm.subarray(off, Math.min(off + TTS_FRAME_BYTES, pcm.length))
      }
    } catch (err) {
      // 失败显式抛错（含 fetch 超时/网络错误）——speakSentence catch 会发 tts-error 提示音。
      console.error('[tts] 调用本地语音服务失败：', err)
      throw err
    }
  }

  /** 统一附加鉴权头：有 apiKey 时带 Bearer，否则原样返回。 */
  private authHeaders(headers: Record<string, string>): Record<string, string> {
    return this.apiKey ? { ...headers, Authorization: `Bearer ${this.apiKey}` } : headers
  }
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
