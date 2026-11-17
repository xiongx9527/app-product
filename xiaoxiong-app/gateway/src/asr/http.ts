import type { AsrProvider } from './provider'
import type { VendorParams } from '../config'

/** 两次中间识别的最小间隔：太密会打满本地服务，太疏界面又会卡顿。 */
const PARTIAL_INTERVAL_MS = 600
/** 音频短于约 0.4 秒时先不识别，避免半截字在界面上抖。 */
const PARTIAL_MIN_BYTES = 12800
/**
 * 单次识别的硬超时：上游 ASR 卡住时主动 abort 断开连接、舍弃这次识别，
 * 不让一轮会话被慢服务拖死（用户感知就是「喊了没反应 / 好慢」）。
 */
const ASR_TIMEOUT_MS = 6000

/**
 * 对接本地语音服务（openai-voice，OpenAI 兼容）的 ASR。
 *
 * 实际接口：POST {baseUrl}/v1/audio/transcriptions（multipart/form-data）
 * baseUrl 默认是本地 AI 服务的 /voice。
 *   - file: WAV 音频（SenseVoice 后端要求 RIFF/WAV，纯 PCM 会报 "does not start with RIFF id"）
 *   - model: whisper-1（服务忽略，后端由 STT_BACKEND 决定）
 *   - language: 可选，如 zh
 *   返回 JSON { text }。
 *
 * 该接口不支持流式，所以中间结果由网关自己“滚动重识别”：每 600ms 把已收音频
 * 整体提交一次，文本有变化就作为 asr.partial 下发，句末再由 finalize 定稿。
 *
 * 网关上行是 16kHz/16bit/单声道 PCM，这里在提交前补 44 字节 WAV 头。
 * 内置 ASR 的模型固定为 sensevoice-small（9529 内置引擎只接受这一个），由 params.model
 * 下发或这里兜底；不可能是 whisper-1——9529 收到未知模型会直接返回错误（表现为“识别不出/无法唤醒”）。
 * 调用失败不抛异常：中间结果静默跳过，定稿回退占位文本，保证会话不中断。
 */
export class HttpVoiceAsr implements AsrProvider {
  private buffer: Buffer[] = []
  private bufferedBytes = 0
  private lastPartialAt = 0
  private partialText = ''
  /** 串行化识别请求：本地服务不必承受并发，定稿也不会和中间结果抢跑。 */
  private inflight: Promise<void> = Promise.resolve()

  constructor(
    private readonly baseUrl: string,
    private readonly params: VendorParams = {},
    private readonly apiKey = '',
  ) {}

  async push(chunk: Uint8Array): Promise<string | null> {
    this.buffer.push(Buffer.from(chunk))
    this.bufferedBytes += chunk.byteLength

    const now = Date.now()
    if (now - this.lastPartialAt < PARTIAL_INTERVAL_MS) return null
    if (this.bufferedBytes < PARTIAL_MIN_BYTES) return null
    this.lastPartialAt = now

    const pcm = Buffer.concat(this.buffer)
    const run = this.inflight.then(() => this.transcribe(pcm, true))
    this.inflight = run.then(
      () => undefined,
      () => undefined,
    )
    const text = await run
    // 文本没变化就不重复下发，减少界面无意义的刷新
    if (!text || text === this.partialText) return null
    this.partialText = text
    return text
  }

  async finalize(): Promise<string> {
    if (this.bufferedBytes === 0) return ''
    await this.inflight
    const pcm = Buffer.concat(this.buffer)
    this.reset()
    return this.transcribe(pcm, false)
  }

  reset(): void {
    this.buffer = []
    this.bufferedBytes = 0
    this.lastPartialAt = 0
    this.partialText = ''
  }

  /** 提交一段 PCM 做识别；partial=true 时失败返回空串（中间结果可丢，定稿不能丢）。 */
  private async transcribe(pcm: Buffer, partial: boolean): Promise<string> {
    try {
      const sampleRate = Number(this.params.sampleRate ?? 16000)
      const wav = pcmToWav(pcm, Number.isFinite(sampleRate) ? sampleRate : 16000)
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
      // 内置 ASR 模型固定为 sensevoice-small（9529 内置引擎唯一接受的模型名）；
      // params.model 可由客户端 session.start.voice.asrModel 覆盖，缺省走这里兜底。
      form.append('model', String(this.params.model ?? 'sensevoice-small'))
      // 语言必须显式下发。SenseVoice 的 language 留空会走自动检测，短句/带噪时会在
      // 中文与拉丁之间摇摆，把中文说成拼音式碎片（实测「李存勖」→「Li chnx.」、
      // 「百科」→「Byaiike」，安静环境也一样），并高频冒 The/Yeah 幻觉。
      // 中文助手默认锁 zh；用户在设置里显式配了 language 则完全尊重其取值。
      form.append('language', String(this.params.language || 'zh'))
      const url = `${this.baseUrl}/v1/audio/transcriptions`
      const res = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders({}),
        body: form,
        signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
      })
      const text = await res.text()
      try {
        const parsed = JSON.parse(text) as { text?: string }
        return typeof parsed.text === 'string' ? parsed.text.trim() : text.trim()
      } catch {
        return text.trim()
      }
    } catch (err) {
      // 超时/断连：舍弃这次识别，partial 静默跳过，定稿回退占位，绝不把会话挂死
      console.error('[asr] 调用本地语音服务失败（已 abort 断开）：', err)
      return partial ? '' : '（ASR 服务暂不可用）'
    }
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
