import type { AsrProvider } from '../asr'
import type { TtsProvider } from '../tts'
import type { AgentService } from './agentService'
import type { DataService } from './dataService'
import type { ClientMessage, Lang, ServerEvent, ServerErrorCode } from '../protocol'
import { messages } from '../i18n'
import { isNoise, resemblesSpoken, pcmRms } from '../asr/noiseFilter'
import { sanitizeForSpeech } from '../tts/sanitize'
import { EnergyVad } from '../vad/energyVad'
import { EchoGuard } from '../vad/echoGuard'

/** 播报期间最多排几句用户插话，超出直接拒收。 */
const MAX_QUEUE = 3
/** 上行能量要高出下发 TTS 帧多少倍，才认定是「真人插话」而不是回声。 */
const ECHO_ENERGY_RATIO = 1.6
/** 播报中连续多少帧被 VAD 判为真人语音，才认定是「用户插话」而打断播报。 */
const BARGEIN_FRAMES = 2

/** 单个语音会话的业务编排：ASR → 智能体 → TTS，并记录日志到数据库。 */
export interface VoiceSessionDeps {
  agentFactory: (lang: Lang) => AgentService
  asr: AsrProvider
  tts: TtsProvider
  data: DataService
  send: (event: ServerEvent) => void
  sendAudio: (bytes: Uint8Array) => void
  asrEndpointMs: number
}

export class VoiceSessionService {
  private active = false
  private cancelled = false
  /** 当前是否有一轮回答在跑（含思考、生成、播报） */
  private processing = false
  private endpointTimer: ReturnType<typeof setTimeout> | null = null
  private lang: Lang = 'zh-CN'
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
  /** 播报中连续被 VAD 判为真人语音的帧数，达到阈值即触发打断播报。 */
  private bargeInCount = 0
  /** 本轮播报被用户插话打断：让正在下发的 TTS 帧停止，不再喂给客户端。 */
  private ttsAborted = false
  /** 当前轮还没播完时识别到的用户插话，播完后依次交给大模型。 */
  private readonly queue: string[] = []
  /** 最近送进 TTS 的原文，用于把「收回来的自己的声音」判成回声丢弃。 */
  private readonly spoken: string[] = []
  /** 本句下发过的最大帧能量，作为回声门控的参考（不能用最后一帧，可能是静音尾）。 */
  private downlinkRmsRef = 0
  /** 本轮已下发的音频字节数，用于估算播放时长做握手超时兜底。 */
  private downlinkBytes = 0
  /** 等待客户端「播完」回执的 resolve；processing 会一直保持到它触发。 */
  private playbackResolve: (() => void) | null = null
  private playbackTimer: ReturnType<typeof setTimeout> | null = null
  /** 定稿串行链：多个 endpoint 定时器重叠时逐句处理，不丢句也不抢同一段缓冲。 */
  private finalizeChain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: VoiceSessionDeps) {}

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
        void this.start(msg.sessionId, msg.lang, msg.mode)
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

  handleBinary(chunk: Uint8Array): void {
    if (!this.active) return
    // 帧一直会来，顺手把到期的回声抑制恢复掉
    if (this.halfDuplex && !this.echo.muted()) this.syncDuplex()
    // 波形级回声门控：客户端还在播这一句时，上行能量没有明显超过下发音频，
    // 说明是扬声器收回来的自己，整帧丢弃，绝不喂给 VAD / ASR。
    // 不整体停止拾音：用户插话要能识别并排队。
    if (this.isEchoFrame(chunk)) return
    // 穿过回声门控到达这里的，只有「非回声的真实人声」—— 播报期间一旦 VAD 连续判出人声，
    // 就是用户在插话：立刻打断播报、优先识别用户的话，避免用户语音和助手播报混音导致漏字。
    const vad = this.vad.push(chunk, { strict: this.playbackPending })
    if (this.playbackPending && vad.voiced && this.downlinkRmsRef > 0) {
      this.bargeInCount += 1
      if (this.bargeInCount >= BARGEIN_FRAMES) this.triggerBargeIn()
    } else {
      this.bargeInCount = 0
    }
    // 静音帧不喂 ASR：否则缓冲会无限增长，每次定稿都要把整段静音送去识别
    for (const frame of vad.frames) {
      void this.deps.asr.push(frame).then((partial) => {
        if (partial) this.deps.send({ type: 'asr.partial', text: partial })
      })
    }
    // 只有真正的人声帧才重置句末计时：静音帧持续到达也会让计时器自然到期
    if (vad.voiced) this.armEndpoint()
  }

  /**
   * 用户插话打断播报：立刻停掉当前这一句的 TTS（不继续下发、并通知客户端 tts.stop），
   * 让用户的语音不再和播报混音，从而能被干净识别；用户这句仍会按正常流程定稿、排队、再播报。
   * 只解除「等播完」握手，不改动 turn / queue，轮到这句时照常处理。
   */
  private triggerBargeIn(): void {
    if (!this.playbackPending) return
    this.playbackPending = false
    this.ttsAborted = true
    this.bargeInCount = 0
    this.deps.send({ type: 'tts.stop' })
    this.resolvePlayback()
    this.syncDuplex()
  }

  /** 半双工状态只在切换时下发一次，避免每帧都刷事件。 */
  private syncDuplex(): void {
    const half = this.echo.muted()
    if (half === this.halfDuplex) return
    this.halfDuplex = half
    this.deps.send({ type: 'audio.duplex', mode: half ? 'half' : 'full' })
  }

  /**
   * 只靠文本比对拦回声太晚（文字已经生成、甚至已经进队列）。
   * 这里在「客户端还没回执播完」的整个窗口内，用能量差把回声帧在进 VAD 之前丢掉：
   * 真人插话会叠加在播报之上，能量明显高于纯回声。
   * 参考值取本句下发过的最大帧能量，避免最后一帧恰好是静音导致门槛失效。
   * 回声反复漏网时倍率自动抬高（只加严，不停拾音），保证插话仍能排队。
   */
  private isEchoFrame(chunk: Uint8Array): boolean {
    if (!this.playbackPending) return false
    if (this.downlinkRmsRef <= 0) return false
    const ratio = ECHO_ENERGY_RATIO * (this.echo.muted() ? 2 : 1)
    return pcmRms(chunk) < this.downlinkRmsRef * ratio
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
    if (this.playbackPending && resemblesSpoken(text, this.spoken)) {
      // 文本级兜底：还是被识别成了自己刚播过的话 → 加严波形门控，但不停止拾音
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
    this.ttsAborted = false
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
        // 从宣布播报起就进入回声门控窗口，直到客户端回执播完
        this.playbackPending = true
        this.downlinkRmsRef = 0
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
      if (ttsStarted && !stale() && !this.ttsAborted) {
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
      if (this.turn !== turn || this.cancelled || this.ttsAborted) return
      // 参考能量取本句最大值：最后一帧常是静音尾，用它会把门控放空
      this.downlinkRmsRef = Math.max(this.downlinkRmsRef, pcmRms(frame))
      this.downlinkBytes += frame.byteLength
      this.echo.onDownlink()
      this.deps.sendAudio(frame)
    }
  }

  private async start(
    _sessionId: string,
    lang: Lang,
    mode: 'wake' | 'dialog' = 'dialog'
  ): Promise<void> {
    this.lang = lang
    this.mode = mode
    this.active = true
    // 新会话作废旧会话的在途回调与排队
    this.turn += 1
    this.cancelled = false
    this.processing = false
    this.speaking = false
    this.playbackPending = false
    this.queue.length = 0
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
    this.echo.release()
    this.syncDuplex()
    this.deps.asr.reset()
    this.vad.reset()
    // 唤醒模式不需要 LLM，省掉一次模型实例构造
    this.agent = mode === 'wake' ? null : this.deps.agentFactory(lang)
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
