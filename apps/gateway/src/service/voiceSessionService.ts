import type { AsrProvider } from '../asr'
import type { TtsProvider } from '../tts'
import type { AgentService } from './agentService'
import type { DataService } from './dataService'
import type { ClientMessage, Lang, ServerEvent, ServerErrorCode } from '../protocol'
import { messages } from '../i18n'

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
  private processing = false
  private endpointTimer: ReturnType<typeof setTimeout> | null = null
  private lang: Lang = 'zh-CN'
  private mode: 'wake' | 'dialog' = 'dialog'
  private sessionRowId = 0
  private agent: AgentService | null = null
  private readonly deviceId: string | null = null

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
    }
  }

  handleBinary(chunk: Uint8Array): void {
    if (!this.active) return
    this.cancelled = false
    void this.deps.asr.push(chunk).then((partial) => {
      if (partial) this.deps.send({ type: 'asr.partial', text: partial })
    })
    this.armEndpoint()
  }

  private armEndpoint(): void {
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.endpointTimer = setTimeout(() => {
      void this.finalizeUtterance()
    }, this.deps.asrEndpointMs)
  }

  private async finalizeUtterance(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      const text = await this.deps.asr.finalize()
      if (!text) {
        this.processing = false
        return
      }
      this.deps.send({ type: 'asr.final', text })
      // 唤醒模式只回识别结果给客户端做唤醒词匹配，不进入 LLM/TTS
      if (this.mode === 'wake') return
      this.deps.data.insertCommandLog(this.deviceId, text, 'pending')
      await this.runAgent(text)
    } catch (err) {
      this.sendError('ASR_TIMEOUT', (err as Error).message)
    } finally {
      this.processing = false
    }
  }

  private async runAgent(text: string): Promise<void> {
    if (!this.agent) return
    try {
      const full = await this.agent.reply(text, (delta) => {
        if (!this.cancelled) this.deps.send({ type: 'llm.delta', text: delta })
      })
      if (this.cancelled) {
        this.deps.data.insertCommandLog(this.deviceId, text, 'cancelled')
        return
      }
      this.deps.send({ type: 'llm.done' })
      this.deps.data.insertCommandLog(this.deviceId, text, full.slice(0, 200))
      await this.runTts(full)
    } catch (err) {
      this.sendError('LLM_ERROR', (err as Error).message)
    }
  }

  private async runTts(text: string): Promise<void> {
    try {
      this.deps.send({ type: 'tts.start', format: 'pcm16', sampleRate: 24000 })
      for await (const frame of this.deps.tts.synthesize(text)) {
        if (this.cancelled) break
        this.deps.sendAudio(frame)
      }
      this.deps.send({ type: 'tts.end' })
    } catch (err) {
      this.sendError('LLM_ERROR', (err as Error).message)
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
    this.cancelled = false
    this.deps.asr.reset()
    // 唤醒模式不需要 LLM，省掉一次模型实例构造
    this.agent = mode === 'wake' ? null : this.deps.agentFactory(lang)
    this.sessionRowId = await this.deps.data.createSession(this.deviceId, Date.now())
  }

  private cancel(): void {
    this.cancelled = true
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.deps.asr.reset()
  }

  private end(): void {
    this.active = false
    this.cancelled = true
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    if (this.sessionRowId) this.deps.data.endSession(this.sessionRowId, Date.now())
    this.deps.asr.reset()
  }

  private sendError(code: ServerErrorCode, message: string): void {
    this.deps.send({ type: 'error', code, message: messages(this.lang).errors[code] ?? message })
  }

  close(): void {
    this.active = false
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.deps.asr.reset()
  }
}
