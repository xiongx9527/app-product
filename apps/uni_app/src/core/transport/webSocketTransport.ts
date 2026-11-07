import { appConfig } from '@/core/config'
import type { AssistantTransport, ServerEvent, SessionMode } from './types'

/** 客户端上报给网关的位置快照（经纬度必填，address 为反向地理编码结果）。 */
interface LocationSnapshot {
  latitude: number
  longitude: number
  address?: string
}

/** 网关 WebSocket 地址解析：
 * 优先级：设置页填的 gatewayWsUrl > 构建期 VITE_GATEWAY_WS_URL > 内置默认本机地址。
 * 每次连接都重新解析，使设置页改地址后在下一次重连生效。 */
function resolveGatewayUrl(): string {
  const configured = appConfig.gatewayWsUrl?.trim()
  if (configured) return configured
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
  /** 构造时显式传入地址则固定使用；否则每次连接按 resolveGatewayUrl() 动态解析 */
  private get activeUrl(): string {
    return this.url || resolveGatewayUrl()
  }
  /** 最近一次获取到的设备位置，连接时随 session.start 上报，之后由 session.location 刷新 */
  private lastLocation: LocationSnapshot | null = null
  private sessionId = ''
  private pendingMode: SessionMode = 'dialog'
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionalClose = false

  constructor(url?: string, lang: 'zh-CN' = 'zh-CN') {
    this.url = url ?? ''
    this.lang = lang
  }

  connect(mode: SessionMode = 'dialog'): Promise<void> {
    if (typeof WebSocket === 'undefined') {
      return Promise.reject(new Error('当前环境不支持 WebSocket'))
    }
    this.pendingMode = mode
    this.intentionalClose = false
    // 外部主动连接时取消待执行的重连，避免同时建两条 socket
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendStart(mode)
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.activeUrl)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      ws.onopen = () => {
        this.sendStart(this.pendingMode)
        // 连接建立后异步取设备位置并上报（不阻塞会话开始）
        void this.fetchAndSendLocation()
        resolve()
      }
      ws.onerror = () => {
        reject(new Error(`无法连接网关：${this.activeUrl}`))
      }
      ws.onclose = () => {
        this.ws = null
        // 网关重启/网络抖动会让页面停留在旧状态，按当前模式自动重连并重新开会话
        if (!this.intentionalClose) this.scheduleReconnect()
      }
      ws.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data)
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect(this.pendingMode).catch(() => {
        // 连不上时 onclose 会继续安排下一次重试
      })
    }, 1000)
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk)
  }

  startSession(mode: SessionMode): void {
    this.sendStart(mode)
  }

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  sendCancel(): void {
    this.sendJson({ type: 'session.cancel' })
  }

  notifyPlaybackDone(): void {
    this.sendJson({ type: 'session.playback_done' })
  }

  close(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
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
    // 时区带当前配置值（默认东 8 区），让时间类工具按用户所在时区返回
    this.sendJson({
      type: 'session.start',
      sessionId: this.sessionId,
      lang: this.lang,
      timezone: appConfig.timezone,
      // 地图服务商配置（逆地理编码）：客户端设置页选择并填 Key，随会话上报
      geocode: { provider: appConfig.geocode.provider, key: appConfig.geocode.key },
      location: this.lastLocation ?? undefined,
      mode,
    })
  }

  /** 取设备位置并上报；取不到（未授权/无 GPS/非 App 端）时静默跳过，不阻断会话。 */
  private async fetchAndSendLocation(): Promise<void> {
    const loc = await this.getDeviceLocation()
    if (!loc) return
    this.lastLocation = loc
    this.sendJson({
      type: 'session.location',
      latitude: loc.latitude,
      longitude: loc.longitude,
      address: loc.address,
    })
  }

  private getDeviceLocation(): Promise<LocationSnapshot | null> {
    return new Promise((resolve) => {
      if (typeof uni === 'undefined' || typeof uni.getLocation !== 'function') {
        resolve(null)
        return
      }
      uni.getLocation({
        type: 'gcj02',
        geocode: true,
        success: (res) =>
          resolve({
            latitude: res.latitude,
            longitude: res.longitude,
            address: typeof res.address === 'string' ? res.address : undefined,
          }),
        fail: () => resolve(null),
      })
    })
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
