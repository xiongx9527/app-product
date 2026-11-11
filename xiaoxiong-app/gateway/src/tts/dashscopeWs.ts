import { randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import type { TtsProvider } from './provider'
import type { VendorParams } from '../config'
import {
  DASHSCOPE_DEFAULT_MODEL,
  DASHSCOPE_DEFAULT_VOICE,
  resolveDashscopeVoice,
} from '../service/ttsVoices'

/** DashScope 实时语音合成默认入口（业务空间专属域名见模块注释）。 */
const DEFAULT_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
/** 等待下行音频的空闲上限：正常合成会持续出帧，长时间无消息视为卡死。 */
const IDLE_TIMEOUT_MS = 15000
/** 网关向客户端声明 pcm16@24000，这里必须与 voiceSessionService 的 tts.start 保持一致。 */
const SAMPLE_RATE = 24000
/** 单次 continue-task 的文本上限（官方限制 20000 字符），避免超长句直接失败。 */
const MAX_TEXT_CHARS = 20000

/**
 * 对接 DashScope 实时语音合成（WebSocket）。
 *
 * 协议要点（官方 CosyVoice 客户端事件）：
 * - 入口：wss://dashscope.aliyuncs.com/api-ws/v1/inference
 *   业务空间专属域名：wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
 * - 握手：Authorization: Bearer <key>，可选 X-DashScope-WorkSpace: <workspace>
 * - 上行：run-task（streaming=duplex，input 必须为空）→ 等 task-started →
 *   continue-task（payload.input.text）→ finish-task（streaming=duplex）→ task-finished
 * - 下行：result-generated 只带句子元信息；音频走 WebSocket binary 通道，逐帧下发
 *
 * 与现有 TtsProvider 的映射：
 * synthesize() 每被调用一次就跑一个 WS 任务，收到一帧就 yield 一帧，客户端可以边收边播；
 * 不再像 HttpVoiceTts 那样等整段音频收完。失败时沿用“回退静音”的策略：
 * 只有完全没收到音频才补静音，已经收到部分音频就让这句自然结束，避免重复出声。
 *
 * 官方建议复用连接处理多个任务；会话是按句调用 synthesize 的，这里仍选择一句一连接：
 * 句末直接关闭最省状态，也不会让上一句的残留音频串到下一句，代价是每句多一次握手。
 *
 * 已接入 createTts 工厂：provider === 'dashscope' 时直接走该实现，
 * baseUrl 既支持 wss:// 原生 WS 入口，也支持 https:// 业务空间域名（自动换算成 /api-ws/v1/inference）。
 */
export class DashScopeWsTts implements TtsProvider {
  private readonly url: string
  private readonly apiKey: string
  private readonly workspace: string
  private readonly model: string
  private readonly voice: string
  private readonly parameters: Record<string, unknown>
  /** 最近一次合成的诊断：是否收到真实音频、失败原因。供健康探测复用，避免重复实现 WS 逻辑。 */
  private lastDiagnosis: { receivedAudio: boolean; error: string | null } = {
    receivedAudio: false,
    error: null,
  }

  constructor(
    baseUrl: string,
    params: VendorParams = {},
    apiKey = '',
  ) {
    this.url = normalizeWsUrl(baseUrl)
    this.apiKey = apiKey.trim()
    // 模型来自请求里的 params.model（客户端按所选音色的「所属模型」下发），不再写死。
    // 仅当请求未带 model（旧客户端）时才回退到 v3-flash 这个较新的默认。
    this.model = stringParam(params.model, DASHSCOPE_DEFAULT_MODEL)
    const requestedVoice = stringParam(params.voice, DASHSCOPE_DEFAULT_VOICE)
    // 官方约束：voice 必须在所选 model 的音色列表里，否则云端回 418 Invalid voice、整句静音。
    // 客户端本地可能存着旧目录的 v1 音色（如 longxiang）或错标音色，这里统一收敛到该模型的
    // 默认音色，保证「有回答就能播」；目录与默认值同源于 ttsVoices.ts，不在两处各写一份。
    this.voice = resolveDashscopeVoice(this.model, requestedVoice)
    if (this.voice !== requestedVoice) {
      console.warn(
        `[tts] 音色 ${requestedVoice} 不属于模型 ${this.model}，回退默认音色 ${this.voice}（避免 418 Invalid voice 静音）`,
      )
    }
    this.workspace = stringParam(params.workspace, '')
    this.parameters = buildParameters(params)
  }

  /** 真合成一句做可用性探测：收到真实音频帧即视为可用；否则返回云端给的具体失败原因。 */
  async probe(sample = '你好'): Promise<{ ok: boolean; message: string }> {
    this.lastDiagnosis = { receivedAudio: false, error: null }
    try {
      // 消费掉音频生成器；真实音频会在合成过程中写入 lastDiagnosis
      for await (const _ of this.synthesize(sample)) {
        /* 不处理帧，仅驱动流程 */
      }
    } catch {
      /* 错误已记录进 lastDiagnosis */
    }
    if (this.lastDiagnosis.receivedAudio) {
      return { ok: true, message: '已接入（真实合成成功）' }
    }
    return {
      ok: false,
      message: this.lastDiagnosis.error
        ? `已配置但合成失败：${this.lastDiagnosis.error}`
        : '已配置但未能合成音频（云端无返回）',
    }
  }

  async *synthesize(text: string): AsyncIterable<Uint8Array> {
    const content = text.trim().slice(0, MAX_TEXT_CHARS)
    if (!content) return

    const ws = new WebSocket(this.url, { headers: this.headers() })
    const taskId = randomUUID().replace(/-/g, '')
    const queue = new MessageQueue()
    let receivedAudio = false
    let started = false
    /** task-finished / task-failed 之后不再发送 continue-task。 */
    let stopped = false

    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        queue.end(new Error(`等待 TTS 下行超时（${IDLE_TIMEOUT_MS}ms）`))
        try {
          ws.terminate()
        } catch {
          /* 已经断开 */
        }
      }, IDLE_TIMEOUT_MS)
    }
    armIdleTimer()

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
        ws.once('close', () => reject(new Error('TTS WebSocket 在建立前关闭')))
      })
      if (ws.readyState !== WebSocket.OPEN) throw new Error('TTS WebSocket 未就绪')
      // 建连本身可能耗时，连上后重新计时，给任务启动留一个完整窗口
      armIdleTimer()

      // 监听器要在 run-task 之前挂好，避免 task-started 抢跑时丢事件
      ws.on('message', (data: RawData, isBinary: boolean) => {
        armIdleTimer()
        if (isBinary) {
          queue.push(rawToBuffer(data))
          return
        }
        const event = parseEvent(data)
        if (!event) return

        if (event.event === 'task-started') {
          if (started || stopped) return
          started = true
          // 文本必须在 task-started 之后用 continue-task 发送；run-task 的 input 固定为 {}
          if (
            !sendJson(ws, {
              header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
              payload: { input: { text: content } },
            })
          ) {
            queue.end(new Error('TTS continue-task 发送失败'))
            return
          }
          // 文本一次发完，立即定稿；服务端会把缓存内容全部合成后再回 task-finished
          if (
            !sendJson(ws, {
              header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
              payload: { input: {} },
            })
          ) {
            queue.end(new Error('TTS finish-task 发送失败'))
          }
          return
        }

        if (event.event === 'task-finished') {
          stopped = true
          queue.end()
          return
        }

        if (event.event === 'task-failed') {
          stopped = true
          console.error('[tts] DashScope 完整失败回包：', event.raw)
          queue.end(
            new Error(
              `DashScope TTS 任务失败：${event.code || '(no code)'} ${event.message || '(no message)'}`,
            ),
          )
        }
        // result-generated 只带句子元信息，音频走二进制帧，这里不需要处理
      })
      ws.on('error', (err: Error) => queue.end(err))
      ws.on('close', () => queue.end())

      const runTask = {
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'tts',
          function: 'SpeechSynthesizer',
          model: this.model,
          input: {},
          parameters: {
            text_type: 'PlainText',
            voice: this.voice,
            ...this.parameters,
          },
        },
      }
      console.error('[tts] DashScope run-task 请求：', JSON.stringify(runTask))
      if (!sendJson(ws, runTask)) {
        throw new Error('TTS run-task 发送失败')
      }

      for await (const chunk of queue.iterate()) {
        if (chunk.byteLength === 0) continue
        receivedAudio = true
        this.lastDiagnosis.receivedAudio = true
        yield chunk
      }
    } catch (err) {
      // 把失败原因写进诊断，供 probe() 回传给健康检测（不再只看主机可达性）。
      this.lastDiagnosis.error = (err as Error).message
      console.error('[tts] DashScope WebSocket 合成失败：', err)
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close()
        else if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
      } catch {
        /* 已经断开 */
      }
    }

    // 一帧都没收到才补静音：保证会话继续，同时避免部分音频后面再叠一段静音
    if (!receivedAudio) yield silenceBytes(content)
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    if (this.workspace) headers['X-DashScope-WorkSpace'] = this.workspace
    return headers
  }
}

/**
 * 下行消息队列：把 ws 的异步事件转成 AsyncIterable，synthesize 才能边收边 yield。
 * 这里只需要处理二进制音频，文本事件在挂载 message 监听时已经分流。
 */
class MessageQueue {
  private readonly parts: Buffer[] = []
  private waiters: Array<() => void> = []
  private done = false
  private error: Error | null = null

  push(part: Buffer): void {
    if (this.done) return
    this.parts.push(part)
    this.wake()
  }

  end(error?: Error): void {
    if (this.done) return
    this.done = true
    if (error) this.error = error
    this.wake()
  }

  async *iterate(): AsyncGenerator<Buffer> {
    while (true) {
      if (this.parts.length > 0) {
        yield this.parts.shift() as Buffer
        continue
      }
      if (this.error) throw this.error
      if (this.done) return
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
}

interface WsEvent {
  event: string
  code: string
  message: string
  raw: string
}

function parseEvent(data: RawData): WsEvent | null {
  const raw = rawToString(data)
  try {
    const json = JSON.parse(raw) as Record<string, unknown>
    const header = isRecord(json.header) ? json.header : {}
    const event = typeof header.event === 'string' ? header.event : ''
    if (!event) return null
    return {
      event,
      code: typeof header.error_code === 'string' ? header.error_code : '',
      message: typeof header.error_message === 'string' ? header.error_message : '',
      raw,
    }
  } catch {
    return null
  }
}

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** ws.send 在 CLOSING/CLOSED 时会抛错，统一收敛成布尔值，调用方按失败处理。 */
function sendJson(ws: WebSocket, message: unknown): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false
  try {
    ws.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

/** 把 HTTP(S) 地址换算成同一 host 的 DashScope WS 入口；已经是 ws(s) 则原样使用。 */
function normalizeWsUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return DEFAULT_WS_URL
  try {
    const url = new URL(value)
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.toString()
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      // /api/v1、/compatible-mode/v1 都对应同一个 WS 入口
      if (!url.pathname.includes('/api-ws/')) url.pathname = '/api-ws/v1/inference'
      url.search = ''
      url.hash = ''
      return url.toString()
    }
  } catch {
    // 非法地址回退默认入口，由 WS 在运行时报错，不阻塞会话
  }
  return DEFAULT_WS_URL
}

/** DashScope 只认 rate，客户端模板给的是 speed，这里统一映射并收敛到官方范围。 */
function buildParameters(params: VendorParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (
      key === 'model' ||
      key === 'voice' ||
      key === 'workspace' ||
      key === 'apiKey' ||
      key === 'baseUrl' ||
      key === 'timeoutMs' ||
      key === 'format' ||
      key === 'text_type' ||
      key === 'sample_rate' ||
      key === 'sampleRate' ||
      key === 'language' ||
      key === 'language_hints'
    ) {
      continue
    }
    if (key === 'speed' || key === 'speechRate' || key === 'speech_rate' || key === 'rate') {
      const rate = clampNumber(value, 0.5, 2)
      if (rate !== null) out.rate = rate
      continue
    }
    if (key === 'volume') {
      const volume = clampNumber(value, 0, 100)
      if (volume !== null) out.volume = volume
      continue
    }
    if (key === 'pitch') {
      const pitch = clampNumber(value, 0.5, 2)
      if (pitch !== null) out.pitch = pitch
      continue
    }
    out[key] = value
  }
  // 客户端按 tts.start 声明的 pcm16@24000 播放，不能被厂商参数改成 wav/mp3 或其它采样率
  out.format = 'pcm'
  out.sample_rate = SAMPLE_RATE
  out.text_type = 'PlainText'

  const hints = languageHints(params.language_hints ?? params.language)
  if (hints.length > 0) out.language_hints = hints
  return out
}

/** language 允许 'zh'、'zh-CN'、'zh,en'；DashScope 的 language_hints 只认基础语言码。 */
function languageHints(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().split('-')[0])
      .filter(Boolean)
  }
  if (typeof value !== 'string') return []
  return value
    .split(',')
    .map((item) => item.trim().split('-')[0])
    .filter(Boolean)
}

function clampNumber(value: unknown, min: number, max: number): number | null {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return Math.min(max, Math.max(min, num))
}

/** 静音帧长度：约按文本长度估，最短 0.1s（24kHz/16bit 单声道 = 48000 B/s）。 */
function silenceBytes(text: string): Uint8Array {
  const bytes = Math.max(4800, text.length * 4800)
  return new Uint8Array(bytes)
}

function stringParam(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}
