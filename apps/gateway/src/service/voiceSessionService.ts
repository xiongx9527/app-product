import type { AsrProvider } from '../asr'
import type { TtsProvider } from '../tts'
import type { AgentService } from './agentService'
import type { DataService } from './dataService'
import type { ClientMessage, GeocodeInfo, Lang, LocationInfo, ServerEvent, ServerErrorCode } from '../protocol'
import type { ReverseGeocoder } from './geocode/types'
import { createGeocodeAdapter } from './geocode'
import { createMusicSource, type MusicSource } from './music'
import { messages } from '../i18n'
import { isNoise, resemblesSpoken } from '../asr/noiseFilter'
import { sanitizeForSpeech } from '../tts/sanitize'
import { EnergyVad } from '../vad/energyVad'
import { EchoGuard } from '../vad/echoGuard'

/** 播报期间最多排几句用户插话，超出直接拒收。 */
const MAX_QUEUE = 3

/** 单个语音会话的业务编排：ASR → 智能体 → TTS，并记录日志到数据库。 */
export interface VoiceSessionDeps {
  agentFactory: (
    lang: Lang,
    timezone?: string,
    locationProvider?: () => LocationInfo | null,
    reverseGeocoder?: ReverseGeocoder,
    musicSource?: MusicSource,
    emit?: (m: ServerEvent) => void
  ) => AgentService
  asr: AsrProvider
  tts: TtsProvider
  data: DataService
  send: (event: ServerEvent) => void
  sendAudio: (bytes: Uint8Array) => void
  asrEndpointMs: number
  /** 网关兜底的天地图 tk（TIANDITU_TK）：客户端未上报 geocode 时仍可用天地图，缺省空 */
  tiandituTk?: string
}

export class VoiceSessionService {
  private active = false
  private cancelled = false
  /** 当前是否有一轮回答在跑（含思考、生成、播报） */
  private processing = false
  private endpointTimer: ReturnType<typeof setTimeout> | null = null
  private lang: Lang = 'zh-CN'
  /** 用户时区（IANA），时间类工具按它返回；缺省东 8 区 */
  private timezone = 'Asia/Shanghai'
  /** 设备最近一次上报的位置；位置类工具实时读取它 */
  private location: LocationInfo | null = null
  /** 天地图逆地理编码（配置了 tk 才有），把经纬度翻成中文地址 */
  private reverseGeocoder: ReverseGeocoder | undefined = undefined
  /** 音乐播放源：按客户端上报的 music 配置构造；未配置则音乐工具不注册 */
  private musicSource: MusicSource | undefined = undefined
  private mode: 'wake' | 'dialog' = 'dialog'
  private sessionRowId = 0
  private agent: AgentService | null = null
  private readonly deviceId: string | null = null
  /**
   * 客户端持续上行（含静音），所以句末不再靠「收不到数据」判断：
   * 只有 VAD 判为语音的帧才喂给 ASR，最后一个人声帧之后静音够久才定稿。
   */
  private readonly vad = new EnergyVad()
  /** 轮次编号：旧轮的在途回调据此作废，避免两轮抢着发事件。 */
  private turn = 0
  /** 是否已经给客户端发过 tts.start（音频帧下发中）。 */
  private speaking = false
  /**
   * 客户端还在播这一句：从 tts.start 起，到 playback_done 回执（或超时）为止。
   * 比 speaking 更晚结束 —— tts.end 只代表下发完，尾音还在扬声器里，
   * 这段时间的上行帧照样是回声，门控必须继续生效。
   */
  private playbackPending = false
  /** AEC 失效兜底：连续被自己的回声打断就降级成半双工。 */
  private readonly echo = new EchoGuard()
  /** 当前是否已通知客户端处于半双工，避免重复下发。 */
  private halfDuplex = false
  /** 当前轮还没播完时识别到的用户插话，播完后依次交给大模型。 */
  private readonly queue: string[] = []
  /** 最近送进 TTS 的原文，用于把「收回来的自己的声音」判成回声丢弃。 */
  private readonly spoken: string[] = []
  /**
   * 最后一次下发音频之后的回声保护窗口（毫秒）：窗口内定稿的文本一律按回声对待。
   * 播放结束（含被打断）后仍留一小段尾巴，盖住扬声器余音经空气/回路传回麦克风的延迟。
   */
  private echoUntil = 0
  /** 本轮已下发的音频字节数，用于估算播放时长做握手超时兜底。 */
  private downlinkBytes = 0
  /** 等待客户端「播完」回执的 resolve；processing 会一直保持到它触发。 */
  private playbackResolve: (() => void) | null = null
  private playbackTimer: ReturnType<typeof setTimeout> | null = null
  /** 定稿串行链：多个 endpoint 定时器重叠时逐句处理，不丢句也不抢同一段缓冲。 */
  private finalizeChain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: VoiceSessionDeps) {
    this.reverseGeocoder = undefined
  }

  /** 按客户端上报（或网关兜底）的配置构造逆地理编码函数；都没配则返回 null。 */
  private buildGeocode(geocode?: GeocodeInfo): ReverseGeocoder | undefined {
    if (geocode?.key) return createGeocodeAdapter(geocode) ?? undefined
    if (this.deps.tiandituTk) {
      return createGeocodeAdapter({ provider: 'tianditu', key: this.deps.tiandituTk }) ?? undefined
    }
    return undefined
  }

  handleText(raw: string): void {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw) as ClientMessage
    } catch {
      this.sendError('LLM_ERROR', '无法解析控制消息')
      return
    }
    switch (msg.type) {
      case 'session.start':
        this.location = msg.location ?? null
        // 逆地理编码：优先用客户端上报的 geocode 配置；没上报则退回网关兜底天地图 tk
        this.reverseGeocoder = this.buildGeocode(msg.geocode)
        // 音乐播放源：按客户端上报的 music 配置构造；未配置（旧客户端/未设置）则音乐工具不注册
        this.musicSource = createMusicSource(msg.music)
        void this.start(msg.sessionId, msg.lang, msg.timezone, msg.mode, this.reverseGeocoder)
        break
      case 'session.location':
        // 连接后或位置变化时刷新最新位置，不影响其它会话状态
        this.location = {
          latitude: msg.latitude,
          longitude: msg.longitude,
          address: msg.address,
        }
        break
      case 'session.cancel':
        this.cancel()
        break
      case 'session.end':
        this.end()
        break
      case 'session.playback_done':
        this.resolvePlayback()
        break
    }
  }

  /** 供位置类工具实时读取会话最近一次上报的设备位置。 */
  getLocation(): LocationInfo | null {
    return this.location
  }

  handleBinary(chunk: Uint8Array): void {
    if (!this.active) return
    // 帧一直会来，顺手把到期的回声抑制恢复掉
    if (this.halfDuplex && !this.echo.muted()) this.syncDuplex()
    const vad = this.vad.push(chunk, { strict: false })
    for (const frame of vad.frames) {
      void this.deps.asr.push(frame).then((partial) => {
        // 播报期间只做唤醒词识别（用定稿），实时草稿不上发给客户端，避免回声刷屏
        if (partial && !this.playbackPending) {
          this.deps.send({ type: 'asr.partial', text: partial })
        }
      })
    }
    // 只有真正的人声帧才重置句末计时：静音帧持续到达也会让计时器自然到期
    if (vad.voiced) this.armEndpoint()
  }

  /** 半双工状态只在切换时下发一次，避免每帧都刷事件。 */
  private syncDuplex(): void {
    const half = this.echo.muted()
    if (half === this.halfDuplex) return
    this.halfDuplex = half
    this.deps.send({ type: 'audio.duplex', mode: half ? 'half' : 'full' })
  }

  private armEndpoint(): void {
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.endpointTimer = setTimeout(() => {
      // 串行而非丢弃：上一句还没交给大模型时，下一句也必须在链里排队等
      this.finalizeChain = this.finalizeChain
        .then(() => this.finalizeUtterance())
        .catch(() => undefined)
    }, this.deps.asrEndpointMs)
  }

  private async finalizeUtterance(): Promise<void> {
    // 打断/关闭后串行链里可能还挂着定稿，不能让它再发 asr.final 或排队
    if (!this.active || this.cancelled) return
    // 只有确认用户说完了（静音够久）才定稿；中间结果从不触发回复
    const text = await this.deps.asr.finalize()
    if (!this.active || this.cancelled) return
    // 环境杂音被 ASR 误识别出的伪文本、以及播报被收回的回声，都静默丢弃，
    // 不进模型也不进队列，避免凭空多出一轮回答和 TTS
    if (!text || isNoise(text)) return
    // 播报（TTS）进行中：不放行成新轮次，也不排队插话——其它声音一律忽略。
    // 但保留唤醒词识别：把识别结果回传客户端做「小熊小熊」比对，
    // 只有命中唤醒词才允许打断，否则播报完整播完。
    // 助手自己刚念过的原话（回声）直接丢弃，且此分支不触发回声兜底静音，
    // 否则会连用户想用来打断的唤醒词一起掐掉。
    if (this.playbackPending) {
      if (Date.now() < this.echoUntil && resemblesSpoken(text, this.spoken)) return
      this.deps.send({ type: 'asr.final', text, queueRemaining: 0 })
      return
    }
    // 文本级回声兜底：刚播完的尾巴里仍可能混进助手说过的原话（含复述用户），
    // 播放结束后的保护窗口内按回声丢弃，避免被当成用户新的一句。
    if (Date.now() < this.echoUntil && resemblesSpoken(text, this.spoken)) {
      this.echo.noteBargeIn()
      this.syncDuplex()
      return
    }

    // 唤醒模式只回识别结果给客户端做唤醒词匹配，不进入 LLM/TTS
    if (this.mode === 'wake') {
      this.deps.send({ type: 'asr.final', text, queueRemaining: 0 })
      return
    }

    // 当前轮还没跑完：不打断、不作废，只把这句排进队列
    if (this.processing) {
      if (this.queue.length >= MAX_QUEUE) {
        this.deps.send({
          type: 'asr.rejected',
          text,
          reason: 'queue-full',
          message: messages(this.lang).queue.full(),
        })
        return
      }
      this.queue.push(text)
      this.deps.send({
        type: 'asr.queued',
        text,
        position: this.queue.length,
        size: MAX_QUEUE,
        message: messages(this.lang).queue.accepted(this.queue.length, MAX_QUEUE),
      })
      return
    }

    this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
    void this.runTurn(text)
  }

  /**
   * 串行跑完一整条链：当前回答 → 等客户端播完 → 队首插话 → …
   * processing 在整条链（含等播完）结束前一直为 true，中途定稿的句子只会进队列。
   * 这样既不会两轮 turn 号互相踩踏，也保证下一句的识别内容要等播完才显示。
   */
  private async runTurn(text: string): Promise<void> {
    if (this.processing) return
    this.processing = true
    // 整条链共用一个 turn：串行执行，不存在两轮互相踩踏。
    // cancel / start 会 ++turn，链据此自行退出。
    const turn = ++this.turn
    this.cancelled = false
    try {
      let current: string | undefined = text
      while (current !== undefined) {
        // 每一句的播报内容与上一句无关，清空回声比对样本
        this.spoken.length = 0
        this.downlinkBytes = 0
        // 先建好等待再开播：客户端可能在音频下发完之前就回执播完
        const playback = this.armPlaybackWait()
        let ttsStarted = false
        try {
          this.deps.data.insertCommandLog(this.deviceId, current, 'pending')
          ttsStarted = await this.runAgent(current, turn)
        } catch (err) {
          this.sendError('LLM_ERROR', (err as Error).message)
        }
        if (this.turn !== turn || this.cancelled) break
        // 必须等这一句真正播完，才轮到下一句：否则会掐掉尾音、
        // 也会让「你说」提前跳到下一句识别内容。
        if (ttsStarted) {
          this.tightenPlaybackTimeout()
          await playback
        } else this.cancelPlaybackWait()
        if (this.turn !== turn || this.cancelled) break
        const next = this.queue.shift()
        if (!next) break
        // 让客户端把界面切到这句，并同步权威剩余数（客户端不靠 ±1 猜测）
        this.deps.send({ type: 'asr.final', text: next, queueRemaining: this.queue.length })
        current = next
      }
    } finally {
      this.processing = false
    }
  }

  /** 先建好「等播完」的 Promise，再开始下发，避免回执早于等待而丢失。 */
  private armPlaybackWait(): Promise<void> {
    this.cancelPlaybackWait()
    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.playbackTimer) clearTimeout(this.playbackTimer)
        this.playbackTimer = null
        this.playbackResolve = null
        // 播完（或超时）后关闭回声门控窗口
        this.playbackPending = false
        resolve()
      }
      this.playbackResolve = done
      // 用固定上限兜底，客户端没回执也不会把队列卡死；
      // 下发完音频后会按实际时长收紧。
      this.playbackTimer = setTimeout(done, 30_000)
    })
  }

  /** 音频下发完后按实际时长收紧超时，避免客户端断线时白等 30 秒。 */
  private tightenPlaybackTimeout(): void {
    const resolve = this.playbackResolve
    if (!resolve) return
    if (this.playbackTimer) clearTimeout(this.playbackTimer)
    // 24kHz/16bit/mono = 48000 字节/秒，再留 1.5 秒余量
    const estimatedMs = (this.downlinkBytes / 48000) * 1000 + 1500
    this.playbackTimer = setTimeout(resolve, Math.max(2000, estimatedMs))
  }

  private cancelPlaybackWait(): void {
    if (this.playbackTimer) clearTimeout(this.playbackTimer)
    this.playbackTimer = null
    // 让正在 await 的链立刻解除阻塞，链随后会检查 cancelled 自行退出
    this.playbackResolve?.()
    this.playbackResolve = null
  }

  private resolvePlayback(): void {
    this.playbackResolve?.()
  }

  /**
   * 边生成边合成：LLM 流式出字，遇到句末标点就把这句立刻交给 TTS，
   * 让首声在 LLM 还没生成完时就响，显著降低语音延迟。
   * turn 用于识别「这一轮已被打断」：旧轮的所有下发都要停。
   */
  /** @returns 是否发出过 tts.start（决定要不要等播放完成回执） */
  private async runAgent(text: string, turn: number): Promise<boolean> {
    if (!this.agent) return false
    const stale = () => this.turn !== turn || this.cancelled
    let buffer = ''
    let ttsStarted = false
    let ttsChain: Promise<void> = Promise.resolve()
    const enqueue = (sentence: string) => {
      // 特殊符号/markdown/emoji 只留在界面，不送进 TTS 念出来
      const clean = sanitizeForSpeech(sentence)
      if (!clean) return
      if (!ttsStarted) {
        ttsStarted = true
        this.speaking = true
        // 从宣布播报起就进入「播放中」窗口，直到客户端回执播完
        this.playbackPending = true
        this.deps.send({ type: 'tts.start', format: 'pcm16', sampleRate: 24000 })
      }
      ttsChain = ttsChain.then(() => this.speakSentence(clean, turn))
    }
    try {
      const full = await this.agent.reply(
        text,
        (delta) => {
          if (stale()) return
          this.deps.send({ type: 'llm.delta', text: delta })
          buffer += delta
          let cut = sentenceCut(buffer)
          while (cut > 0) {
            enqueue(buffer.slice(0, cut))
            buffer = buffer.slice(cut)
            cut = sentenceCut(buffer)
          }
        },
        (delta) => {
          // 思考过程只给界面看，不进 buffer、不进 TTS
          if (stale()) return
          this.deps.send({ type: 'llm.thinking', text: delta })
        }
      )
      if (stale()) {
        this.deps.data.insertCommandLog(this.deviceId, text, 'cancelled')
        return ttsStarted
      }
      enqueue(buffer)
      buffer = ''
      this.deps.send({ type: 'llm.done' })
      this.deps.data.insertCommandLog(this.deviceId, text, full.slice(0, 200))
      await ttsChain
      if (ttsStarted && !stale()) {
        this.speaking = false
        this.deps.send({ type: 'tts.end' })
      }
      return ttsStarted
    } catch (err) {
      if (stale()) return ttsStarted
      this.sendError('LLM_ERROR', (err as Error).message)
      return ttsStarted
    }
  }

  private async speakSentence(sentence: string, turn: number): Promise<void> {
    if (this.turn !== turn || this.cancelled) return
    this.spoken.push(sentence)
    // 只留最近几句：回声延迟有限，太久以前的文本不该再参与比对
    if (this.spoken.length > 6) this.spoken.shift()
    for await (const frame of this.deps.tts.synthesize(sentence)) {
      if (this.turn !== turn || this.cancelled) return
      this.downlinkBytes += frame.byteLength
      this.echo.onDownlink()
      // 每下发一帧就把回声保护窗口往后挪：窗口始终盖住「最后一帧之后的一小段余音」
      this.echoUntil = Date.now() + 1200
      this.deps.sendAudio(frame)
    }
  }

  private async start(
    _sessionId: string,
    lang: Lang,
    timezone?: string,
    mode: 'wake' | 'dialog' = 'dialog',
    reverseGeocoder?: ReverseGeocoder
  ): Promise<void> {
    this.lang = lang
    // 用户没带时区或带的是非法值就退回东 8 区
    this.timezone = timezone?.trim() || 'Asia/Shanghai'
    this.reverseGeocoder = reverseGeocoder
    this.mode = mode
    this.active = true
    // 新会话作废旧会话的在途回调与排队
    this.turn += 1
    this.cancelled = false
    this.processing = false
    this.speaking = false
    this.playbackPending = false
    this.echoUntil = 0
    this.queue.length = 0
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
    this.echo.release()
    this.syncDuplex()
    this.deps.asr.reset()
    this.vad.reset()
    // 唤醒模式不需要 LLM，省掉一次模型实例构造
    this.agent =
      mode === 'wake'
        ? null
        : this.deps.agentFactory(
            lang,
            this.timezone,
            () => this.getLocation(),
            this.reverseGeocoder,
            this.musicSource,
            (m) => this.deps.send(m)
          )
    this.sessionRowId = await this.deps.data.createSession(this.deviceId, Date.now())
  }

  private cancel(): void {
    // 手动打断：作废当前轮、清空排队，在途回调靠 turn 号退出
    const wasSpeaking = this.speaking
    this.turn += 1
    this.cancelled = true
    this.processing = false
    this.speaking = false
    this.playbackPending = false
    this.echoUntil = 0
    this.queue.length = 0
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
    if (wasSpeaking) this.deps.send({ type: 'tts.stop' })
    // 手动打断证明是真人，解除回声兜底
    this.echo.release()
    this.syncDuplex()
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.deps.asr.reset()
    this.vad.reset()
  }

  private end(): void {
    this.active = false
    this.cancelled = true
    this.turn += 1
    this.speaking = false
    this.playbackPending = false
    this.echoUntil = 0
    this.queue.length = 0
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    if (this.sessionRowId) this.deps.data.endSession(this.sessionRowId, Date.now())
    this.deps.asr.reset()
    this.vad.reset()
  }

  private sendError(code: ServerErrorCode, message: string): void {
    this.deps.send({ type: 'error', code, message: messages(this.lang).errors[code] ?? message })
  }

  close(): void {
    this.active = false
    this.playbackPending = false
    this.echoUntil = 0
    this.queue.length = 0
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.deps.asr.reset()
    this.vad.reset()
  }
}

/**
 * 返回一句的切分位置（含句末标点），用于边生成边合成。
 * 无标点时若缓冲过长，退而按逗号或固定长度切，避免迟迟不出声。
 */
function sentenceCut(text: string): number {
  const match = text.match(/[。！？；!?;\n]/)
  if (match && match.index !== undefined) return match.index + 1
  if (text.length >= 60) {
    const comma = Math.max(text.lastIndexOf('，'), text.lastIndexOf(','))
    return comma > 0 ? comma + 1 : 60
  }
  return -1
}
