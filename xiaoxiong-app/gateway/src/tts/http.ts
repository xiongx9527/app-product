import type { TtsProvider } from './provider'
import type { VendorParams } from '../config'
import { TIMEOUT_DEFAULTS } from '../timeouts'
import type { ResolvedTimeouts } from '../timeouts'

/**
 * 单句合成超时（默认 25s，可被设置页覆盖）。
 *
 * 原则：绝不一次合成整段长文本，而是按断句逐句合成（见 voiceSessionService 的 flushTts）。
 * 单句一般 <100 字、edge-tts 合成约 7–16s，25s 足够且真挂起时能较快兜底。
 * 必须小于「帧间看门狗 × 重试次数」——否则看门狗会先把还在正常合成的句子判成卡死。
 *
 * 历史：曾放宽到 90s 想让 300 字整段一次合成成功（实测 42s），那是掩盖问题、
 * 违反「边合成边读」原则，已回退。
 */
const TTS_TIMEOUT_MS = TIMEOUT_DEFAULTS.ttsMs
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
    /** 会话级时间预算（设置页可配）：缺省用 timeouts.ts 的默认值。 */
    private readonly timeouts?: ResolvedTimeouts,
  ) {}

  async *synthesize(text: string): AsyncIterable<Uint8Array> {
    // 公网链路偶发抖动（TLS 断连/超时）会让单次 fetch 抛错 → 误报「这段没能播报」，所以重试 1 次。
    // 关键：两次共享**同一份总预算**（ttsMs），而不是各给一份——否则 25s×2=50s 会超过
    // 帧间看门狗 30s，重试还没跑完这句就被判成卡死，重试等于白写。
    // 预算内失败才重试；预算见底就直接抛错走 tts-error。
    const budgetMs = this.timeouts?.ttsMs ?? TTS_TIMEOUT_MS
    const deadline = Date.now() + budgetMs
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now()
      if (remaining < 1000) break
      try {
        const pcm = await this.fetchPcm(text, remaining)
        // 整段 TTS（builtin/deepseek 一次返回完整 WAV）必须切成小帧下发：
        // 原生 playPcm(String b64) 每帧 Base64.decode 后写 AudioTrack，单帧 1.2MB（base64 1.6MB）
        // 经 weex 桥传输会超限/截断 → 播不出来。切成 9600B(200ms@24k) 匹配流式播放。
        for (let off = 0; off < pcm.length; off += TTS_FRAME_BYTES) {
          yield pcm.subarray(off, Math.min(off + TTS_FRAME_BYTES, pcm.length))
        }
        return
      } catch (err) {
        lastErr = err
        if (attempt === 0) console.warn('[tts] 合成失败，预算内重试一次：', err)
      }
    }
    // 预算耗尽/两次都失败：显式抛错——speakSentence catch 会发 tts-error 本地 mp3 提示。
    console.error('[tts] 调用语音服务失败（已重试）：', lastErr)
    throw lastErr ?? new Error('[tts] 合成超时')
  }

  /** 单次 TTS 合成请求：fetch + 校验 WAV + 提取 PCM。 */
  private async fetchPcm(text: string, timeoutMs: number): Promise<Uint8Array> {
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
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok || !res.body) throw new Error(`[tts] 合成失败 HTTP ${res.status}`)
    const contentType = res.headers.get('content-type') ?? ''
    const ab = new Uint8Array(await res.arrayBuffer())
    if (contentType.includes('application/json') || !isRiff(ab)) {
      throw new Error('[tts] 合成失败：响应非 WAV')
    }
    const pcm = extractWavData(ab)
    if (pcm.length === 0) throw new Error('[tts] 合成失败：WAV 无 data 段')
    return pcm
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
