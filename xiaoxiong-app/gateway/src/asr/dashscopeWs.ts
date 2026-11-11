import { randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'
import type { AsrProvider } from './provider'
import type { VendorParams } from '../config'

/** DashScope 实时语音识别默认入口（业务空间专属域名见模块注释）。 */
const DEFAULT_WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
/** 从建连到 task-started 的上限：超时就放弃本句，不能让会话一直等。 */
const START_TIMEOUT_MS = 8000
/** 发出 finish-task 后等待 task-finished 的上限；超时用已有中间结果定稿。 */
const FINISH_TIMEOUT_MS = 8000
/** 建连失败后的重试冷却：避免每个音频帧都发起一次连接。 */
const RECONNECT_COOLDOWN_MS = 3000
/** 网关上行固定是 16kHz/16bit 单声道 PCM，不能交给厂商参数覆盖。 */
const SAMPLE_RATE = 16000
/** 连不上时最多缓存最近 30 秒 16kHz/16bit 单声道音频，防止内存无限涨。 */
const MAX_BUFFERED_BYTES = SAMPLE_RATE * 2 * 30

/**
 * 对接 DashScope 实时语音识别（WebSocket）。
 *
 * 协议要点：
 * - 入口：wss://dashscope.aliyuncs.com/api-ws/v1/inference
 *   业务空间专属域名：wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference
 * - 握手：Authorization: Bearer <key>，可选 X-DashScope-WorkSpace: <workspace>
 * - 上行：先发 run-task（streaming=duplex，task=asr），收到 task-started 后持续发
 *   二进制 PCM，句末发 finish-task（streaming=duplex），服务端回 task-finished。
 * - 下行：result-generated 里取 payload.output.sentence（兼容 payload.sentence 与数组），
 *   sentence_end=true 才是定稿；heartbeat=true 的心跳包直接跳过。
 *
 * 与现有 AsrProvider 的映射：
 * - push() 把音频送进 WS，并返回“最新的中间文本”。DashScope 的结果是异步事件，
 *   所以 partial 会在下一次 push 时带出去；VoiceSessionService 本身也是每帧调用。
 * - finalize() 发 finish-task，等 task-finished（或超时）后返回累计文本，并自行
 *   reset（与 HttpVoiceAsr 的约定一致）。
 *
 * 一个连接只跑一句话：句末关闭，下一句重新建连。这样不用赌服务端是否允许
 * 同一连接连续跑多个任务，重连/打断也只需要 terminate 一个 socket。
 *
 * 已接入 createAsr 工厂：config.asr.provider === 'dashscope' 时直接走该实现，
 * baseUrl 既支持 wss:// 原生 WS 入口，也支持 https:// 业务空间域名（自动换算成 /api-ws/v1/inference）。
 */
export class DashScopeWsAsr implements AsrProvider {
  private readonly url: string
  private readonly apiKey: string
  private readonly workspace: string
  private readonly model: string
  private readonly parameters: Record<string, unknown>

  private ws: WebSocket | null = null
  private taskId = ''
  private ready = false
  private startPromise: Promise<void> | null = null
  private startSettle: ((err?: Error) => void) | null = null
  private startTimer: ReturnType<typeof setTimeout> | null = null
  private lastAttemptAt = 0
  /** 每次连接/重置递增，旧 socket 的迟到事件据此直接丢弃。 */
  private gen = 0

  private audio: Buffer[] = []
  private audioBytes = 0
  private sentBytes = 0

  /** 已定稿的句子（sentence_end=true），按 begin_time 去重后追加。 */
  private committed: string[] = []
  private committedBegin: number | null = null
  /** 当前句子的最新中间文本。 */
  private current = ''
  private lastReturned = ''

  private finished = false
  /** 本句任务已被服务端判失败（连接会被关闭），不再重连或补发 finish-task。 */
  private failed = false
  private finishWaiters: Array<() => void> = []
  private finishTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    baseUrl: string,
    params: VendorParams = {},
    apiKey = '',
  ) {
    this.url = normalizeWsUrl(baseUrl)
    this.apiKey = apiKey.trim()
    this.model = stringParam(params.model, 'paraformer-realtime-v2')
    this.workspace = stringParam(params.workspace, '')
    this.parameters = buildParameters(params)
  }

  async push(chunk: Uint8Array): Promise<string | null> {
    if (chunk.byteLength > 0) {
      if (this.ready) {
        if (!this.sendAudio(chunk)) {
          // 发送失败说明连接已经不可用：退回缓存，等下一次重连补发
          this.ready = false
          this.bufferAudio(chunk)
          this.maybeStart()
        }
      } else {
        this.bufferAudio(chunk)
        this.maybeStart()
      }
    }
    return this.takePartial()
  }

  async finalize(): Promise<string> {
    // 这一轮没有任何上行音频（例如 VAD 只切出了静音）：不建连、不产生空转任务
    if (this.sentBytes === 0 && this.audioBytes === 0) {
      this.reset()
      return ''
    }

    // task-failed 后连接已被服务端关闭，重连也没有音频可补发，直接用中间结果定稿
    if (!this.failed) {
      try {
        await this.start()
        const ws = this.ws
        if (ws?.readyState === WebSocket.OPEN && !this.finished && !this.failed) {
          ws.send(
            JSON.stringify({
              header: { task_id: this.taskId, streaming: 'duplex', action: 'finish-task' },
              payload: { input: {} },
            }),
          )
          await this.waitFinished()
        }
      } catch (err) {
        // 建连/定稿失败不中断会话：把已经拿到的中间结果当作最终文本
        console.error('[asr] DashScope WebSocket 定稿失败：', err)
      }
    }

    const text = this.text()
    // 与 HttpVoiceAsr 一致：finalize 自己收尾，调用方不需要再 reset
    this.reset()
    return text
  }

  reset(): void {
    this.closeSocket()
    this.resolveFinished()
    this.committed = []
    this.committedBegin = null
    this.current = ''
    this.lastReturned = ''
    this.finished = false
    this.failed = false
    this.lastAttemptAt = 0
    this.audio = []
    this.audioBytes = 0
    this.sentBytes = 0
  }

  /** 懒建连：首帧音频到达时才连，空闲会话不占 WS。 */
  private maybeStart(): void {
    if (this.failed || this.ready || this.startPromise) return
    if (Date.now() - this.lastAttemptAt < RECONNECT_COOLDOWN_MS) return
    this.lastAttemptAt = Date.now()
    void this.start().catch((err) => {
      console.error('[asr] DashScope WebSocket 建连失败：', err)
    })
  }

  private start(): Promise<void> {
    if (this.failed) return Promise.reject(new Error('本句 ASR 任务已失败，不再重连'))
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) return Promise.resolve()
    // 正在建连时复用同一个 promise，避免每帧都开新连接
    if (this.startPromise && !this.ready) return this.startPromise

    this.closeSocket()
    const gen = this.gen
    const taskId = randomUUID().replace(/-/g, '')
    this.taskId = taskId
    this.finished = false

    const ws = new WebSocket(this.url, { headers: this.headers() })
    this.ws = ws

    const promise = new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (err?: Error): void => {
        if (settled) return
        settled = true
        if (this.startSettle === settle) this.startSettle = null
        if (this.startTimer) {
          clearTimeout(this.startTimer)
          this.startTimer = null
        }
        if (err) reject(err)
        else resolve()
      }
      this.startSettle = settle
      this.startTimer = setTimeout(() => {
        settle(new Error(`等待 task-started 超时（${START_TIMEOUT_MS}ms）`))
        ws.terminate()
      }, START_TIMEOUT_MS)

      ws.on('open', () => {
        if (this.gen !== gen) return
        try {
          ws.send(
            JSON.stringify({
              header: { task_id: taskId, streaming: 'duplex', action: 'run-task' },
              payload: {
                model: this.model,
                task_group: 'audio',
                task: 'asr',
                function: 'recognition',
                input: {},
                parameters: this.parameters,
              },
            }),
          )
        } catch (err) {
          settle(err instanceof Error ? err : new Error(String(err)))
        }
      })

      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (this.gen !== gen) return
        // ASR 下行只有文本事件，没有二进制音频
        if (isBinary) return
        const event = parseEvent(data)
        if (!event) return

        switch (event.event) {
          case 'task-started':
            this.ready = true
            settle()
            this.flushAudio()
            break
          case 'result-generated':
            this.onResult(event.payload)
            break
          case 'task-finished':
            this.finished = true
            this.resolveFinished()
            break
          case 'task-failed':
            console.error(
              '[asr] DashScope 任务失败：',
              event.code || '(no code)',
              event.message || '(no message)',
            )
            // 服务端随后会关闭连接；标记后不再重连、也不再补发 finish-task
            this.failed = true
            if (!this.ready) settle(new Error(event.message || 'task-failed'))
            this.ready = false
            this.resolveFinished()
            break
        }
      })

      ws.on('error', (err: Error) => {
        if (this.gen !== gen) return
        this.ready = false
        settle(err)
        this.resolveFinished()
      })

      ws.on('close', () => {
        if (this.gen !== gen) return
        this.ready = false
        settle(new Error('DashScope ASR 连接在 task-started 前关闭'))
        this.resolveFinished()
      })
    })

    this.startPromise = promise
    // 成功/失败都要清掉，否则连接断开后会一直复用这个已完成的 promise，无法重连
    void promise.then(
      () => {
        if (this.startPromise === promise) this.startPromise = null
      },
      () => {
        if (this.startPromise === promise) this.startPromise = null
        if (this.gen === gen) this.ready = false
      },
    )
    return promise
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    if (this.workspace) headers['X-DashScope-WorkSpace'] = this.workspace
    return headers
  }

  private sendAudio(chunk: Uint8Array): boolean {
    const ws = this.ws
    if (ws?.readyState !== WebSocket.OPEN) return false
    const buf = Buffer.from(chunk)
    try {
      ws.send(buf)
    } catch {
      return false
    }
    this.sentBytes += buf.byteLength
    return true
  }

  private bufferAudio(chunk: Uint8Array): void {
    const buf = Buffer.from(chunk)
    this.audio.push(buf)
    this.audioBytes += buf.byteLength
    // 连接迟迟建不起来时丢最早的音频，保留最近一段仍有机会被识别
    while (this.audioBytes > MAX_BUFFERED_BYTES && this.audio.length > 1) {
      const dropped = this.audio.shift()
      if (dropped) this.audioBytes -= dropped.byteLength
    }
  }

  private flushAudio(): void {
    const pending = this.audio
    this.audio = []
    this.audioBytes = 0
    for (const chunk of pending) {
      // 刚建连就发送失败时把音频放回缓存，等重连后补发
      if (!this.sendAudio(chunk)) {
        this.ready = false
        this.bufferAudio(chunk)
      }
    }
  }

  /**
   * 解析一句识别结果。DashScope 文档给的是 payload.output.sentence，
   * 老版本 SDK 可能返回 sentence 数组，两种都兼容。
   */
  private onResult(payload: Record<string, unknown> | null): void {
    if (!payload) return
    const output = isRecord(payload.output) ? payload.output : payload
    const sentence = output.sentence
    if (Array.isArray(sentence)) {
      for (const item of sentence) {
        if (isRecord(item)) this.onSentence(item)
      }
      return
    }
    if (isRecord(sentence)) this.onSentence(sentence)
  }

  private onSentence(sentence: Record<string, unknown>): void {
    // heartbeat 是维持连接的静音心跳，不是用户说话
    if (sentence.heartbeat === true) return

    const text = typeof sentence.text === 'string' ? sentence.text.trim() : ''
    if (!text) return

    const begin = typeof sentence.begin_time === 'number' ? sentence.begin_time : null
    const endTime = sentence.end_time
    // 新模型用 sentence_end 表示定稿；老模型没有该字段，用 end_time 是否为空兜底
    const ended =
      sentence.sentence_end === true ||
      (sentence.sentence_end === undefined && endTime !== undefined && endTime !== null)

    if (ended) {
      const last = this.committed.length - 1
      // 同一句的最终结果可能重复下发，按 begin_time 覆盖而不是再追加一遍
      if (begin !== null && this.committedBegin === begin && last >= 0) {
        this.committed[last] = text
      } else {
        this.committed.push(text)
      }
      this.committedBegin = begin
      this.current = ''
    } else {
      this.current = text
    }
  }

  private text(): string {
    return [...this.committed, this.current].filter(Boolean).join('').trim()
  }

  /** 只在文本变化时返回，避免界面无意义刷新。 */
  private takePartial(): string | null {
    const text = this.text()
    if (!text || text === this.lastReturned) return null
    this.lastReturned = text
    return text
  }

  private waitFinished(): Promise<void> {
    if (this.finished) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.finishWaiters.push(resolve)
      if (!this.finishTimer) {
        this.finishTimer = setTimeout(() => this.resolveFinished(), FINISH_TIMEOUT_MS)
      }
    })
  }

  private resolveFinished(): void {
    if (this.finishTimer) {
      clearTimeout(this.finishTimer)
      this.finishTimer = null
    }
    const waiters = this.finishWaiters
    this.finishWaiters = []
    for (const resolve of waiters) resolve()
  }

  /**
   * 只关闭当前连接，不清理音频与累计文本：
   * start() 重连时要保留尚未发送的音频，finalize() 也要先取文本再 reset。
   */
  private closeSocket(): void {
    this.gen += 1
    this.ready = false
    this.startPromise = null
    this.startSettle?.()
    this.startSettle = null
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    if (this.finishTimer) {
      clearTimeout(this.finishTimer)
      this.finishTimer = null
    }
    this.taskId = ''

    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.terminate()
      } catch {
        /* 已经断开 */
      }
    }
  }
}

interface WsEvent {
  event: string
  code: string
  message: string
  payload: Record<string, unknown> | null
}

function parseEvent(data: RawData): WsEvent | null {
  try {
    const json = JSON.parse(rawToString(data)) as Record<string, unknown>
    const header = isRecord(json.header) ? json.header : {}
    const event = typeof header.event === 'string' ? header.event : ''
    if (!event) return null
    return {
      event,
      code: typeof header.error_code === 'string' ? header.error_code : '',
      message: typeof header.error_message === 'string' ? header.error_message : '',
      payload: isRecord(json.payload) ? json.payload : null,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    // 非法地址回退默认入口，由 WS 在运行时报错，不阻塞会话启动
  }
  return DEFAULT_WS_URL
}

function buildParameters(params: VendorParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (
      key === 'model' ||
      key === 'workspace' ||
      key === 'apiKey' ||
      key === 'baseUrl' ||
      key === 'timeoutMs' ||
      key === 'language' ||
      key === 'language_hints' ||
      key === 'format' ||
      key === 'sample_rate' ||
      key === 'sampleRate'
    ) {
      continue
    }
    out[key] = value
  }
  // 网关上行固定是 16kHz/16bit/单声道 PCM，格式和采样率不能交给厂商参数覆盖，
  // 否则服务端会按错误采样率解码，识别结果直接变成乱码
  out.format = 'pcm'
  out.sample_rate = SAMPLE_RATE
  const hints = languageHints(params.language_hints ?? params.language)
  if (hints.length > 0) out.language_hints = hints
  return out
}

/** language 允许 'zh'、'zh-CN'、'zh,en'，DashScope 的 language_hints 只认基础语言码。 */
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

function stringParam(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}
