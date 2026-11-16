import { appConfig, activeVoiceConfig } from '@/core/config'
import { DEFAULT_GATEWAY_WS_URL } from '@/core/config/constants'
import { getDeviceId } from '@/core/config/deviceId'
import { getGatewayWsUrl, isEmbeddedGateway } from './gatewayBootstrap'
import { t } from '@/core/i18n'
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

/** WebSocket 最小接口：浏览器原生 WebSocket 与 uni SocketTask 适配层共用。 */
interface WsLike {
  readyState: number
  send(data: string | ArrayBuffer): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
}

/** WebSocket.OPEN = 1（App 端逻辑层没有 WebSocket 全局，常量自备）。 */
const WS_OPEN = 1

/** uni.connectSocket 的 SocketTask 最小形状（各运行时版本差异大，按需收窄）。 */
interface UniSocketTask {
  send: (o: { data: string | ArrayBuffer }) => void
  close: (o?: { code?: number; reason?: string }) => void
  onOpen: (cb: () => void) => void
  onMessage: (cb: (res: { data: unknown }) => void) => void
  onClose: (cb: () => void) => void
  onError: (cb: () => void) => void
}

/** 用 SocketTask 包一层 WsLike；task 形状不符（如返回 Promise/undefined 的运行时）返回 null。 */
function likeFromTask(task: UniSocketTask | undefined | null): WsLike | null {
  if (!task || typeof task.onOpen !== 'function' || typeof task.send !== 'function') return null
  const like: WsLike = {
    readyState: 0,
    send: (data) => task.send({ data }),
    close: () => task.close({}),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  task.onOpen(() => {
    like.readyState = WS_OPEN
    like.onopen?.()
  })
  task.onMessage((res) => {
    like.onmessage?.({ data: res.data })
  })
  task.onClose(() => {
    like.readyState = 3
    like.onclose?.()
  })
  task.onError(() => like.onerror?.())
  return like
}

/**
 * 全局回调 API 适配（部分 App 运行时 connectSocket 不返回 SocketTask，只提供
 * uni.onSocketOpen 等全局回调）：单连接语义，正合本传输层的单 socket 用法。
 * alive 守卫：close 后旧回调不再触发。
 */
function likeFromGlobal(url: string): WsLike {
  const u = uni as unknown as {
    connectSocket: (o: { url: string }) => void
    sendSocketMessage: (o: { data: string | ArrayBuffer }) => void
    closeSocket: (o?: { code?: number; reason?: string }) => void
    onSocketOpen: (cb: () => void) => void
    onSocketMessage: (cb: (res: { data: unknown }) => void) => void
    onSocketClose: (cb: () => void) => void
    onSocketError: (cb: () => void) => void
  }
  let alive = true
  const like: WsLike = {
    readyState: 0,
    send: (data) => u.sendSocketMessage({ data }),
    close: () => {
      alive = false
      u.closeSocket({})
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  u.onSocketOpen(() => {
    if (!alive) return
    like.readyState = WS_OPEN
    like.onopen?.()
  })
  u.onSocketMessage((res) => {
    if (!alive) return
    like.onmessage?.({ data: res.data })
  })
  u.onSocketClose(() => {
    if (!alive) return
    like.readyState = 3
    like.onclose?.()
  })
  u.onSocketError(() => {
    if (!alive) return
    like.onerror?.()
  })
  u.connectSocket({ url })
  return like
}

/**
 * 建 socket：浏览器（H5）用原生 WebSocket；App 端逻辑层（v8 服务上下文）没有 WebSocket
 * 全局，走 uni.connectSocket。
 *
 * 关键（真机血泪）：DCloud 的 uni.connectSocket 被 promisify 包装——若不传回调，返回的是
 * Promise 且 resolve 出来只有 errMsg（拿不到 SocketTask）；此时若退回 uni.onSocketMessage
 * 全局回调，运行时只把消息投递给 socketTasks[0]，反复建连/重连后归属错乱，ASR 下行全部丢失
 * （表现为喊「小熊小熊」永远唤不醒）。解法：传一个 success 空回调，让 promisify 走 hasCallback
 * 分支——uni.connectSocket 会「同步返回」真正的 SocketTask（带 onOpen/onMessage/send），
 * 于是用 likeFromTask 注册每一条连接自己的局部回调，不依赖有缺陷的全局回调，也不重复建连。
 */
function createSocket(url: string): Promise<WsLike> {
  if (typeof WebSocket !== 'undefined') {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    return Promise.resolve(ws as unknown as WsLike)
  }
  const connect = (uni as unknown as {
    connectSocket?: (o: {
      url: string
      success?: () => void
      fail?: (e: unknown) => void
    }) => UniSocketTask | Promise<UniSocketTask> | undefined
  } | undefined)?.connectSocket
  if (typeof connect !== 'function') {
    return Promise.reject(new Error('当前环境不支持 WebSocket'))
  }
  let ret: UniSocketTask | Promise<UniSocketTask> | undefined
  try {
    // 传 success/fail 空回调：强制 promisify 走同步返回 SocketTask 分支（见上方注释）
    ret = connect({ url, success: () => {}, fail: () => {} })
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }
  if (ret && typeof (ret as UniSocketTask).onOpen === 'function') {
    // 同步返回的 SocketTask：局部回调，可靠且单连接
    return Promise.resolve(likeFromTask(ret as UniSocketTask) as WsLike)
  }
  // 兜底：极少数运行时即使传了回调仍返回 Promise，解析后再取 SocketTask
  if (ret && typeof (ret as Promise<UniSocketTask>).then === 'function') {
    return Promise.resolve(ret as Promise<UniSocketTask>).then((t) => {
      const like = likeFromTask(t)
      return like ?? likeFromGlobal(url)
    })
  }
  return Promise.resolve(likeFromGlobal(url))
}

/**
 * 真实网关传输：文本帧走 JSON 控制消息，二进制帧走音频（上下行方向天然区分）。
 * 不依赖任何 Mock，直接连 Node 网关的 /ws。
 */
export class WebSocketTransport implements AssistantTransport {
  private ws: WsLike | null = null
  private readonly eventListeners = new Set<(event: ServerEvent) => void>()
  private readonly audioListeners = new Set<(chunk: ArrayBuffer) => void>()
  /** 连接状态订阅：界面据此显示「网关已连 / 未连」，免去开 DevTools 看 WS。 */
  private readonly statusListeners = new Set<(connected: boolean) => void>()
  private connected = false
  /** 是否正在建连（含自动重连的每次尝试）；界面据此在状态胶囊显示「连接中…」 */
  private connecting = false
  private readonly connectingListeners = new Set<(value: boolean) => void>()
  private readonly url: string
  /** 内嵌网关（APP-PLUS）下由原生回传的动态端口 WS 地址；每次 connect 重新解析（不缓存，
   * 见 connectInternal 注释：应对首启端口文件竞态与重连自愈）。 */
  private resolvedEmbeddedUrl: string | null = null
  private readonly lang: 'zh-CN'
  /** 构造时显式传入地址则固定使用；内嵌网关已解析到动态端口则优先；否则回退构建期/默认地址。 */
  private get activeUrl(): string {
    if (this.url) return this.url
    if (this.resolvedEmbeddedUrl) return this.resolvedEmbeddedUrl
    return resolveGatewayUrl()
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
  /** 自动重连已用次数；每次外部 connect / 成功建连清零，避免无限重试 */
  private reconnectAttempts = 0
  /** 自动重连上限：耗尽后停止自动重试，改由用户手动「重试连接」 */
  private readonly maxReconnectAttempts: number
  /** 自动重连是否已耗尽（连不上且不再自动重试）；外部 connect 成功会清零 */
  private reconnectExhausted = false
  /** 自动重连次数耗尽的订阅者 */
  private readonly exhaustedListeners = new Set<() => void>()

  constructor(url?: string, lang: 'zh-CN' = 'zh-CN', maxReconnectAttempts = 999) {
    this.url = url ?? ''
    this.lang = lang
    this.maxReconnectAttempts = maxReconnectAttempts
  }

  connect(mode: SessionMode = 'dialog'): Promise<void> {
    // 外部主动连接（含用户手动重试）：重置重连预算与耗尽标记，从头开始算
    this.reconnectAttempts = 0
    this.reconnectExhausted = false
    return this.connectInternal(mode)
  }

  /** 真正的建连逻辑；外部 connect 与内部自动重连共用，外部调用前已清零重连预算。 */
  private async connectInternal(mode: SessionMode): Promise<void> {
    // 环境支持判断移入 createSocket：浏览器原生 WebSocket / App 端 uni.connectSocket 二选一
    this.pendingMode = mode
    this.intentionalClose = false
    this.reconnectExhausted = false
    // 内嵌网关（APP-PLUS）：建连前先拿原生回传的动态端口地址（best-effort，失败回退默认）。
    // 每次 connect 都重新解析而非缓存：首启时 :gateway 进程可能尚未把 gateway.url 写好，
    // 若缓存一次失败结果会永远连不上；重连时端口若变化也能自愈。
    // H5 / 开发 / 单测环境 isEmbeddedGateway() 为 false，跳过，行为与之前完全一致。
    if (!this.url && isEmbeddedGateway()) {
      this.resolvedEmbeddedUrl = await getGatewayWsUrl()
    }
    // 建连开始：通知界面显示「连接中…」
    this.setConnecting(true)
    // 外部主动连接时取消待执行的重连，避免同时建两条 socket
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.sendStart(mode)
      return Promise.resolve()
    }
    const ws = await createSocket(this.deviceWsUrl)
    this.ws = ws
    return new Promise<void>((resolve, reject) => {
      // 连接超时兜底：DCloud connectSocket 在网关未就绪时可能既不 onopen 也不
      // onerror/onclose（fail 回调被 promisify 吞掉），Promise 永挂会让调用方
      // enable() 的 await 永不返回、finally 不执行、防重入锁 enabling 永久锁死，
      // 之后所有点击/连接全部失效（autoConnect 首启撞网关冷启动必现）。
      // 超时后主动 close 并置空，让自动重连可以继续建新连接。
      const connectTimer = setTimeout(() => {
        if (this.ws !== ws) return
        this.ws = null
        try { ws.close?.() } catch { /* 忽略 */ }
        this.setConnected(false)
        reject(new Error(t('error.gatewayConnectFailed', { url: this.activeUrl })))
      }, 6_000)
      ws.onopen = () => {
        clearTimeout(connectTimer)
        if (this.ws !== ws) return // 陈旧 socket 事件（重连后被顶掉的旧连接）忽略
        this.reconnectAttempts = 0
        this.reconnectExhausted = false
        this.setConnecting(false)
        this.setConnected(true)
        this.sendStart(this.pendingMode)
        // 不再建连即主动取位置：改为懒加载——只有用户问到位置/天气时，网关才会下发
        // client.location.request，客户端此时才请求定位授权并上报，避免冷启动就弹定位框。
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(connectTimer)
        if (this.ws !== ws) return
        // 不在此清 connecting：通常随后会触发 onclose，由 onclose 决定是否继续显示「连接中…」
        this.setConnected(false)
        reject(new Error(t('error.gatewayConnectFailed', { url: this.activeUrl })))
      }
      ws.onclose = () => {
        clearTimeout(connectTimer)
        if (this.ws !== ws) return
        this.ws = null
        this.setConnected(false)
        // 网关重启/网络抖动：继续自动重连，保持「连接中…」直到成功或耗尽，
        // 避免每次重试间隙闪回「未连接」；耗尽后停止并交由状态胶囊提示手动重连。
        if (!this.intentionalClose) this.scheduleReconnect()
        else this.setConnecting(false)
      }
      ws.onmessage = (ev: { data: unknown }) => {
        if (this.ws !== ws) return
        this.handleMessage(ev.data)
      }
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    // 已达自动重连上限：停止自动重试，结束「连接中…」，通知上层（由上层念「网关连不上」）
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setConnecting(false)
      this.markExhausted()
      return
    }
    // 进入重连周期：立即显示「连接中…」，并在整个周期内保持，直到成功或耗尽
    this.setConnecting(true)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.reconnectAttempts += 1
      if (this.reconnectAttempts > this.maxReconnectAttempts) {
        this.setConnecting(false)
        this.markExhausted()
        return
      }
      void this.connectInternal(this.pendingMode).catch(() => {
        // 连不上时 onclose 会继续安排下一次重试
      })
    }, Math.min(1000 * Math.max(1, this.reconnectAttempts), 3000))
  }

  private markExhausted(): void {
    if (this.reconnectExhausted) return
    this.reconnectExhausted = true
    this.exhaustedListeners.forEach((listener) => listener())
  }

  // 临时诊断：统计发送/丢弃帧数，定位「采集端有声但网关收不到」
  private diagSent = 0
  private diagDropped = 0
  private diagAt = 0

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(chunk)
      this.diagSent += 1
    } else {
      this.diagDropped += 1
    }
    const now = Date.now()
    if (now - this.diagAt >= 2000) {
      try {
        uni.setStorageSync('__ws_send_diag', {
          t: now,
          sent: this.diagSent,
          dropped: this.diagDropped,
          readyState: this.ws ? this.ws.readyState : -1,
        })
      } catch {
        // 诊断写失败不影响主流程
      }
      this.diagSent = 0
      this.diagDropped = 0
      this.diagAt = now
    }
  }

  startSession(mode: SessionMode): void {
    this.sendStart(mode)
  }

  /**
   * 设置变更（语音来源 / 播放设置等）后重武装当前 WS 会话：在已连的 socket 上重新下发
   * session.start，网关据此用新配置重建 ASR / TTS / LLM，无需重连（对话记忆与会话行不丢）。
   * 仅在已连时有效；未连则无会话可重武装，由 connect 自行带最新配置建连。
   */
  rearm(): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.sendStart(this.pendingMode)
    }
  }

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WS_OPEN
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

  private setConnecting(value: boolean): void {
    if (this.connecting === value) return
    this.connecting = value
    this.connectingListeners.forEach((listener) => listener(value))
  }

  /** 订阅「正在建连」状态变化（含自动重连每次尝试）；订阅时立即回灌一次当前值。 */
  onConnecting(listener: (value: boolean) => void): () => void {
    this.connectingListeners.add(listener)
    listener(this.connecting)
    return () => this.connectingListeners.delete(listener)
  }

  /** 订阅自动重连耗尽（连不上且不再自动重试）；订阅时若已耗尽立即回灌一次。 */
  onReconnectExhausted(listener: () => void): () => void {
    this.exhaustedListeners.add(listener)
    if (this.reconnectExhausted) listener()
    return () => this.exhaustedListeners.delete(listener)
  }

  sendCancel(): void {
    this.sendJson({ type: 'session.cancel' })
  }

  /** 播报/思考中重新喊唤醒词：只跳过当前句、保留队列（区别于 sendCancel 的整轮重来）。
   *  dropText 带上命中的唤醒词原文，网关据此从队列移除这句（它经 asr.queued 入过队）。 */
  sendSkipCurrent(dropText?: string): void {
    this.sendJson({ type: 'session.skip_current', ...(dropText ? { dropText } : {}) })
  }

  requestMusicNext(genre?: string): void {
    this.sendJson({ type: 'music.next', genre })
  }

  reportVolume(volume: number): void {
    this.sendJson({ type: 'music.volume', volume })
  }

  notifyPlaybackDone(): void {
    this.sendJson({ type: 'session.playback_done' })
  }

  /** 播放设置实时变更：设置页改了播放源/自动字幕/默认循环/默认音量/自动循环后推送，网关据此立即重建音乐源或刷新开关，无需重连/重唤醒 */
  notifyPlaybackSource(source: string, autoSubtitle?: boolean, defaultLoop?: number, defaultVolume?: number, autoLoop?: boolean): void {
    this.sendJson({
      type: 'session.playback',
      source,
      ...(typeof autoSubtitle === 'boolean' ? { autoSubtitle } : {}),
      ...(typeof defaultLoop === 'number' ? { defaultLoop } : {}),
      ...(typeof defaultVolume === 'number' ? { defaultVolume } : {}),
      ...(typeof autoLoop === 'boolean' ? { autoLoop } : {}),
    })
  }

  close(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.sendJson({ type: 'session.end' })
    this.ws?.close()
    this.ws = null
    this.setConnected(false)
    this.setConnecting(false)
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
      // 语音服务配置（ASR / LLM / TTS 共用一份）：取当前来源这一份压平后下发，
      // 网关按 provider 展开成三套地址；旧客户端不带 voice → 网关完全沿用自身 env，行为不变
      voice: activeVoiceConfig(),
      // 播放设置（音乐播放源等）：来自客户端设置页，网关据此决定点歌走哪个来源；缺省百度。
      // autoSubtitle 一并下发：网关据此在每次播放时自动拉取并展示同源字幕（缺省开启）。
      // defaultLoop / defaultVolume 一并下发：网关据此在每次新播放时带入 loop / media.volume（缺省 3 / 0.5）。
      playback: {
        source: appConfig.playback.source,
        autoSubtitle: appConfig.playback.autoSubtitle ?? true,
        defaultLoop: appConfig.playback.defaultLoop,
        defaultVolume: appConfig.playback.defaultVolume,
        autoLoop: appConfig.playback.autoLoop ?? false,
      },
      // 推荐条数（好价商品）：来自客户端设置页，网关据此作为工具默认条数（缺省 3、范围 1–10）。
      recommend: {
        dealsCount: appConfig.recommend.dealsCount,
      },
      // 记忆设置：自动记忆（自动抽取）开关与合并（摘要）阈值/频率，来自客户端设置页。
      // 缺省关；手动指令不受此开关影响。阈值/频率缺省由网关运行配置决定。
      memory: {
        auto: appConfig.memory.autoMemory,
        consolidateThreshold: appConfig.memory.consolidateThreshold,
        consolidateEvery: appConfig.memory.consolidateEvery,
      },
      // MCP 服务器列表：来自客户端设置页，仅启用项下发网关。网关据此连上并把其工具注册进助手工具箱。
      // rearm 也会重新下发，故修改即时生效（下次 start / 重武装即生效）。总开关关闭时整体不下发。
      mcp: {
        servers: appConfig.mcp.enabled
          ? appConfig.mcp.servers
              .filter((s) => s.enabled)
              .map((s) => ({
                name: s.name,
                transport: s.transport,
                command: s.command,
                args: s.args,
                env: s.env,
                url: s.url,
                headers: s.headers,
                enabledTools: s.enabledTools,
                disabledTools: s.disabledTools,
              }))
          : [],
      },
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
    if (this.ws && this.ws.readyState === WS_OPEN) this.ws.send(JSON.stringify(payload))
  }

  private handleMessage(data: unknown): void {
    if (typeof data === 'string') {
      try {
        const event = JSON.parse(data) as ServerEvent
        // 懒加载定位：网关要位置时再取并上报，不在建连时打扰用户
        if (event.type === 'client.location.request') {
          void this.fetchAndSendLocation()
        }
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
