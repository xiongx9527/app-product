import { appConfig } from '@/core/config'
import { DEFAULT_GATEWAY_WS_URL } from '@/core/config/constants'
import { getDeviceId } from '@/core/config/deviceId'
import type { AssistantTransport, ServerEvent, SessionMode } from './types'

/** 客户端上报给网关的位置快照（经纬度必填，address 为反向地理编码结果）。 */
interface LocationSnapshot {
  latitude: number
  longitude: number
  address?: string
}

/** 网关 WebSocket 地址解析：唯一来源是构建期 VITE_GATEWAY_WS_URL（由 dev 脚本按后端
 * PORT 注入，或 .env 配置）；未注入时回退内置默认本机地址。不再提供设置页手动配置，
 * 前后端地址统一由这一个来源决定。每次连接都重新解析。
 * 浏览器走 import.meta.env；Node / 单元测试环境 vitest 经 process.env 注入，一并兼容。 */
export function resolveGatewayUrl(): string {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const fromMeta = metaEnv?.VITE_GATEWAY_WS_URL?.trim()
  if (fromMeta) return fromMeta
  if (typeof process !== 'undefined') {
    const fromProc = process.env?.VITE_GATEWAY_WS_URL?.trim()
    if (fromProc) return fromProc
  }
  return DEFAULT_GATEWAY_WS_URL
}

/**
 * 由网关 WS 地址派生 HTTP 基地址（scheme://host:port），供 /music/stream 代理拼 URL。
 * 不依赖全局 URL（App/Harmony 的 JS 引擎未必有），纯字符串处理。
 */
export function resolveGatewayHttpBase(): string {
  let http = resolveGatewayUrl()
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
  const schemeEnd = http.indexOf('://') + 3
  const slash = http.indexOf('/', schemeEnd)
  if (slash !== -1) http = http.slice(0, slash)
  return http
}

/**
 * 真实网关传输：文本帧走 JSON 控制消息，二进制帧走音频（上下行方向天然区分）。
 * 不依赖任何 Mock，直接连 Node 网关的 /ws。
 */
export class WebSocketTransport implements AssistantTransport {
  private ws: WebSocket | null = null
  private readonly eventListeners = new Set<(event: ServerEvent) => void>()
  private readonly audioListeners = new Set<(chunk: ArrayBuffer) => void>()
  /** 连接状态订阅：界面据此显示「网关已连 / 未连」，免去开 DevTools 看 WS。 */
  private readonly statusListeners = new Set<(connected: boolean) => void>()
  private connected = false
  private readonly url: string
  private readonly lang: 'zh-CN'
  /** 构造时显式传入地址则固定使用；否则每次连接按 resolveGatewayUrl() 动态解析 */
  private get activeUrl(): string {
    return this.url || resolveGatewayUrl()
  }
  /** 在 WS 地址上附带本机稳定 deviceId，供网关按设备复用会话（重连/重唤醒不丢记忆）。 */
  private get deviceWsUrl(): string {
    const base = this.activeUrl
    const id = encodeURIComponent(getDeviceId())
    return base.includes('?') ? `${base}&deviceId=${id}` : `${base}?deviceId=${id}`
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
      const ws = new WebSocket(this.deviceWsUrl)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      ws.onopen = () => {
        this.setConnected(true)
        this.sendStart(this.pendingMode)
        // 连接建立后异步取设备位置并上报（不阻塞会话开始）
        void this.fetchAndSendLocation()
        resolve()
      }
      ws.onerror = () => {
        this.setConnected(false)
        reject(new Error(`无法连接网关：${this.activeUrl}`))
      }
      ws.onclose = () => {
        this.ws = null
        this.setConnected(false)
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

  /** 订阅连接状态变化（网关 WS 是否当前连通）；订阅时立即回灌一次当前值。 */
  onStatusChange(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.connected)
    return () => this.statusListeners.delete(listener)
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return
    this.connected = value
    this.statusListeners.forEach((listener) => listener(value))
  }

  sendCancel(): void {
    this.sendJson({ type: 'session.cancel' })
  }

  requestMusicNext(genre?: string): void {
    this.sendJson({ type: 'music.next', genre })
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
    this.setConnected(false)
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
      // 音乐为网关内置能力，无需客户端上报配置
      location: this.lastLocation ?? undefined,
      mode,
      // 本机稳定设备标识：网关据此复用会话（重连/重唤醒保留记忆）；URL query 也带一份作主路径
      deviceId: getDeviceId(),
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
      // 先显式申请定位授权：manifest 已声明权限，这里主动触发系统授权框，
      // 避免冷启动时 getLocation 在某些机型上静默失败、用户既没看到提示、位置也永远拿不到。
      // 已授权/平台不支持显式授权时直接放行；用户拒绝则静默跳过（定位只是增强项，不阻断会话）。
      this.ensureLocationAuthorized()
        .then(() => this.doGetLocation(resolve))
        .catch(() => resolve(null))
    })
  }

  /** 确保定位已授权：已授权或平台不支持显式授权时 resolve；用户拒绝 reject。 */
  private ensureLocationAuthorized(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof uni === 'undefined' || typeof uni.authorize !== 'function') {
        resolve()
        return
      }
      uni.authorize({
        scope: 'scope.location',
        success: () => resolve(),
        fail: () => resolve(),
      })
    })
  }

  private doGetLocation(resolve: (value: LocationSnapshot | null) => void): void {
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
