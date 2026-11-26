import type { AsrProvider } from './provider'
import type { VendorParams } from '../config'
import { TIMEOUT_DEFAULTS } from '../timeouts'
import type { ResolvedTimeouts } from '../timeouts'

/** 两次中间识别的最小间隔：太密会打满本地服务，太疏界面又会卡顿。 */
const PARTIAL_INTERVAL_MS = TIMEOUT_DEFAULTS.asrPartialIntervalMs
/**
 * 首次 partial 的最少音频：0.8 秒（16k/16bit=25600 字节）。
 * 实测（TTS 真语音喂内置 SenseVoice）：0.4s 音频识别出空串、0.8s 才出第一个字
 * （「今天天气。」）。原来 12800B(0.4s) 会让第一次识别白跑一轮、首字拖到 ~2.1s；
 * 提到 0.8s 让首次识别就出字，首字降到 ~1.7s。仍是从头识别整段，绝不滑动窗口丢字。
 */
const PARTIAL_MIN_BYTES = 25600
/**
 * 中间识别（partial）与定稿识别（finalize）用不同的超时预算，原因见 timeouts.ts：
 * partial 只负责实时字幕、失败就跳过，必须快速失败；finalize 失败等于整轮白说，必须给足。
 * 两者都可被客户端设置页覆盖（session.start.timeouts），这里只是缺省值。
 */
const PARTIAL_TIMEOUT_MS = TIMEOUT_DEFAULTS.asrPartialMs
const FINALIZE_TIMEOUT_MS = TIMEOUT_DEFAULTS.asrFinalizeMs
/** buffer 累积上限（约16秒 @16k/16bit=512000 bytes）：正常句子不会触发，仅异常长音频
 *  滑动窗口防爆——曾出现"今天天气怎么样"重复39遍、vd=55s。超出丢最旧帧，配合
 *  stripTrailingEcho 去尾部重复。 */
const MAX_BUFFER_BYTES = 512000

/** 单次识别结果。failed=true 表示上游调用失败（超时/非2xx/断连），text 无意义——
 *  定稿层据此抛错走 asr-error 提示，绝不把失败当用户原话送进 LLM（曾踩坑：上游500时
 *  错误页正文被当成用户说的话，答了一轮不相干内容）。 */
interface TranscribeResult {
  text: string
  speechDuration: number
  failed: boolean
}

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
  /** 最近一次 finalize 音频的 VAD 真语音秒数（-1=无数据/未装模型），供网关幻觉二级判断。 */
  speechDuration = -1
  /** 【2026-11-23】最近一次 finalize 整段音频的平均 RMS，用于识别"播报回声/余音"
   *  （回声 rms≈0.001，真人说话 rms≈0.01+）；配合 speechDuration<0 可靠区分回声与真人选号。 */
  lastRms = -1
  /** 串行化识别请求：本地服务不必承受并发，定稿也不会和中间结果抢跑。 */
  private inflight: Promise<void> = Promise.resolve()
  /** 上一次 partial 识别是否还在进行；忙时不再直接丢弃，而是记 pending。 */
  private partialBusy = false
  /** 忙期间又有新音频到达：识别一结束立即用最新整段补一次，不空等下个 600ms 间隔。
   *  实测单次识别 ~1s > 间隔 600ms，旧实现把中途触发全丢掉 → 字幕 ~2.2s 才刷一次、卡顿。
   *  补识别仍是从头识别整段（文本天然累积、绝不丢字），只是不等固定间隔。 */
  private partialPending = false

  constructor(
    private readonly baseUrl: string,
    private readonly params: VendorParams = {},
    private readonly apiKey = '',
    /** 会话级时间预算（设置页可配）：缺省用 timeouts.ts 的默认值。 */
    private readonly timeouts?: ResolvedTimeouts,
  ) {}

  private get partialIntervalMs(): number {
    return this.timeouts?.asrPartialIntervalMs ?? PARTIAL_INTERVAL_MS
  }

  private get partialTimeoutMs(): number {
    return this.timeouts?.asrPartialMs ?? PARTIAL_TIMEOUT_MS
  }

  private get finalizeTimeoutMs(): number {
    return this.timeouts?.asrFinalizeMs ?? FINALIZE_TIMEOUT_MS
  }

  async push(chunk: Uint8Array): Promise<string | null> {
    this.buffer.push(Buffer.from(chunk))
    this.bufferedBytes += chunk.byteLength
    // 异常长音频防爆：超过上限丢最旧帧（正常句子不触发）
    while (this.bufferedBytes > MAX_BUFFER_BYTES && this.buffer.length > 1) {
      const dropped = this.buffer.shift()
      this.bufferedBytes -= dropped ? dropped.byteLength : 0
    }

    return this.runPartial()
  }

  /**
   * 启动一次中间识别（从头识别整段 buffer，文本天然累积不丢字）。
   * 忙时只记 pending 不排队发请求；识别完由 finally 用最新 buffer 立即补一次，
   * 让字幕刷新跟手（~1s 一次）而不是被固定间隔拖成 ~2.2s 一次。
   */
  private async runPartial(): Promise<string | null> {
    if (this.partialBusy) {
      this.partialPending = true
      return null
    }
    const now = Date.now()
    // 补识别（pending）跳过间隔节流；普通触发仍按间隔。
    if (!this.partialPending && now - this.lastPartialAt < this.partialIntervalMs) return null
    if (this.bufferedBytes < PARTIAL_MIN_BYTES) {
      this.partialPending = false
      return null
    }

    this.lastPartialAt = now
    this.partialPending = false
    this.partialBusy = true
    const pcm = Buffer.concat(this.buffer)
    const run = this.inflight.then(() => this.transcribe(pcm, this.partialTimeoutMs))
    this.inflight = run.then(
      () => undefined,
      () => undefined,
    )
    try {
      const { text } = await run
      // 文本没变化就不重复下发，减少界面无意义的刷新
      if (!text || text === this.partialText) return null
      this.partialText = text
      return text
    } finally {
      this.partialBusy = false
      // 不在这里 fire-and-forget 补识别：它的文本没法下发给 App（本轮 push 的返回链已结束）。
      // 帧持续进入（每 256ms），下一次 push 会看到 partialPending 并跳过间隔节流立即补识别，
      // 文本经那次 push 的返回链正常下发。
    }
  }

  async finalize(): Promise<string> {
    if (this.bufferedBytes === 0) return ''
    await this.inflight
    const pcm = Buffer.concat(this.buffer)
    // 【2026-11-23】算整段平均 RMS（16bit 单声道），供网关识别播报回声/余音。
    let sum = 0
    const n = Math.floor(pcm.byteLength / 2)
    for (let i = 0; i < n; i += 1) {
      const s = pcm.readInt16LE(i * 2) / 32768
      sum += s * s
    }
    this.lastRms = n > 0 ? Math.sqrt(sum / n) : 0
    this.reset()
    // finalize 是「用户说完、整段音频」的定稿识别：失败先重试 1 次（上游偶发抖动/超时），
    // 两次都失败才抛错走 asr-error。partial 中途失败仍静默跳过（下一轮会补），不重试。
    let result = await this.transcribe(pcm, this.finalizeTimeoutMs)
    if (result.failed) {
      console.warn('[asr] 定稿识别失败，重试一次')
      result = await this.transcribe(pcm, this.finalizeTimeoutMs)
    }
    this.speechDuration = result.speechDuration
    // 识别失败绝不能当「用户说的话」往下走：真机 2026-11-18 实锤，ASR 上游 500 时
    // 曾把错误正文当成用户输入交给大模型，答了一轮完全不相干的内容。
    // 两次都失败才抛给 finalizeUtterance 的 catch：下发 asr-error 提示音并丢弃本轮。
    if (result.failed) throw new Error('asr unavailable')
    return result.text
  }

  reset(): void {
    this.buffer = []
    this.bufferedBytes = 0
    this.lastPartialAt = 0
    this.partialText = ''
    this.speechDuration = -1
    this.partialBusy = false
    this.partialPending = false
  }

  /** 提交一段 PCM 做识别；失败返回 failed=true + 空 text（partial 层静默跳过，定稿层抛错）。
   *  speechDuration 是 9529 用 Silero VAD 判出的真语音秒数（-1=无数据），供幻觉二级判断。
   *  timeoutMs：partial 与 finalize 用不同预算，见文件头两个常量的说明。 */
  private async transcribe(pcm: Buffer, timeoutMs: number): Promise<TranscribeResult> {
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
        signal: AbortSignal.timeout(timeoutMs),
      })
      // 非 2xx（网关/上游 500）不是识别结果：直接当失败处理，绝不能把错误页正文
      // 当成用户说的话往下走（否则会送进大模型答非所问）。
      if (!res.ok) throw new Error(`ASR HTTP ${res.status}`)
      const text = await res.text()
      try {
        const parsed = JSON.parse(text) as { text?: string; speech_duration?: number }
        const sd = typeof parsed.speech_duration === 'number' && Number.isFinite(parsed.speech_duration)
          ? parsed.speech_duration : -1
        return { text: typeof parsed.text === 'string' ? parsed.text.trim() : text.trim(), speechDuration: sd, failed: false }
      } catch {
        return { text: text.trim(), speechDuration: -1, failed: false }
      }
    } catch (err) {
      // 超时/断连：舍弃这次识别，partial 静默跳过，定稿抛错走 asr-error 提示，绝不把会话挂死。
      // 带上 timeoutMs 以便区分是 partial(6s) 还是定稿(12s) 超时——排障时不用猜。
      console.error(`[asr] 调用本地语音服务失败（已 abort 断开，timeoutMs=${timeoutMs}）：`, err)
      return { text: '', speechDuration: -1, failed: true }
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
