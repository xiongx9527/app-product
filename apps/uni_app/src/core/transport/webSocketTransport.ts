import type { AssistantTransport, ServerEvent, SessionMode } from './types'

/** 网关默认 WebSocket 地址：H5 桌面调试直连本机；可用 VITE_GATEWAY_WS_URL 覆盖（如模拟器用 10.0.2.2）。 */
function resolveGatewayUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  return env?.VITE_GATEWAY_WS_URL ?? 'ws://127.0.0.1:8787/ws'
}

/**
 * 真实网关传输：文本帧走 JSON 控制消息，二进制帧走音频（上下行方向天然区分）。
 * 不依赖任何 Mock，直接连 Node 网关的 /ws。
 */
export class WebSocketTransport implements AssistantTransport {
  private ws: WebSocket | null = null
  private readonly eventListeners = new Set<(event: ServerEvent) => void>()
  private readonly audioListeners = new Set<(chunk: ArrayBuffer) => void>()
  private readonly url: string
  private readonly lang: 'zh-CN'
  private sessionId = ''
  private pendingMode: SessionMode = 'dialog'

  constructor(url = resolveGatewayUrl(), lang: 'zh-CN' = 'zh-CN') {
    this.url = url
    this.lang = lang
  }

  connect(mode: SessionMode = 'dialog'): Promise<void> {
    if (typeof WebSocket === 'undefined') {
      return Promise.reject(new Error('当前环境不支持 WebSocket'))
    }
    this.pendingMode = mode
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendStart(mode)
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      ws.onopen = () => {
        this.sendStart(this.pendingMode)
        resolve()
      }
      ws.onerror = () => {
        reject(new Error(`无法连接网关：${this.url}`))
      }
      ws.onclose = () => {
        this.ws = null
      }
      ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data)
    })
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk)
  }

  startSession(mode: SessionMode): void {
    this.sendStart(mode)
  }

  sendCancel(): void {
    this.sendJson({ type: 'session.cancel' })
  }

  close(): void {
    this.sendJson({ type: 'session.end' })
    this.ws?.close()
    this.ws = null
  }

  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onAudio(listener: (chunk: ArrayBuffer) => void): () => void {
    this.audioListeners.add(listener)
    return () => this.audioListeners.delete(listener)
  }

  private sendStart(mode: SessionMode): void {
    this.sessionId = `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    this.sendJson({ type: 'session.start', sessionId: this.sessionId, lang: this.lang, mode })
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }

  private handleMessage(data: unknown): void {
    if (typeof data === 'string') {
      try {
        const event = JSON.parse(data) as ServerEvent
        this.eventListeners.forEach((listener) => listener(event))
      } catch {
        // 非法 JSON 帧忽略
      }
      return
    }
    if (data instanceof ArrayBuffer) {
      this.audioListeners.forEach((listener) => listener(data))
    }
  }
}
