import { WebSocket, type RawData } from 'ws'
import type { IncomingMessage } from 'node:http'
import { createAgentService } from '../service/agentService'
import { createAsr } from '../asr'
import { createTts } from '../tts'
import { resolveCapabilityConfig } from '../voiceConfig'
import { VoiceSessionService } from '../service/voiceSessionService'
import { getSession, setSession, removeSession } from '../service/sessionRegistry'
import type { GatewayConfig } from '../config'
import type { DataService } from '../service/dataService'
import type { ServerEvent } from '../protocol'
import type { CorrectionSyncer } from '../service/asrCorrectionSync'
// 内容能力工厂（具体实现收口在 service/content/assembly，controller 不 import 具体 skill）。
import {
  contentSourceFactory, contentResolverFactory, contentExecutorFactory, contentDashDeps,
} from '../service/content/assembly'

export interface VoiceControllerDeps {
  config: GatewayConfig
  data: DataService
  correctionSyncer?: CorrectionSyncer
  /** 本次网关启用的 skill 模块（按配置加载），交给每个会话 create 实例。 */
  skillModules?: import('../service/skills/types').SkillModule[]
}

/** 从 WS 握手请求里取 deviceId（客户端随连接 URL query 上报）；缺省空表示旧客户端。 */
function deviceIdFromRequest(req: IncomingMessage): string | null {
  const raw = req.url ?? ''
  const q = raw.indexOf('?')
  if (q === -1) return null
  const id = new URLSearchParams(raw.slice(q + 1)).get('deviceId')
  return id && id.length > 0 ? id : null
}

/** query 参数 role=pcm 表示「音频专用连接」：原生 WakeModule 用它直接上报 PCM，
 *  绕开播报期失效的 weex keepAlive 回调。这类连接只喂音频帧、绝不 bindTransport，
 *  否则会把 session 的事件下发抢到原生连接、JS 收不到 asr.partial/tts.start。 */
function queryParam(req: IncomingMessage, key: string): string | null {
  const raw = req.url ?? ''
  const q = raw.indexOf('?')
  if (q === -1) return null
  return new URLSearchParams(raw.slice(q + 1)).get(key)
}

/**
 * 原生 PCM 直连连接表：deviceId → WebSocket。
 * 这条连接双向二进制：原生 send=采集 PCM（喂 handleBinary），网关 send=TTS 音频（原生直接写
 * AudioTrack、不经 JS）。播报期 JS 线程被 TTS 处理占满会让 weex 回调全失效，故 TTS 音频也走
 * 这条原生连接，让播报期 JS 空载、socket 文本回调恢复、插话文字能显示。
 */
const pcmConnections = new Map<string, WebSocket>()

/**
 * 音频专用连接：原生直连上报 PCM + 接收 TTS 音频。只把上行二进制帧喂给既有 session
 * （按 deviceId 复用），不建 session、不 bindTransport，绝不影响 JS 主连接的事件收发。
 */
function createPcmUploadConnection(ws: WebSocket, req: IncomingMessage): () => void {
  const deviceId = deviceIdFromRequest(req)
  if (deviceId) pcmConnections.set(deviceId, ws)
  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (!deviceId) return
    const session = getSession(deviceId)
    if (!session) return // 主连接还没建 session，丢弃这几帧
    if (!isBinary) {
      // 原生直连上行的文本控制帧（TTS 播完回执 session.playback_done）：走 handleText，
      // 不经 weex 下行回调（播报期不可靠，铁证：客户端只能靠 12s 兜底）。
      try { session.handleText(data.toString()) } catch { /* 忽略非法文本帧 */ }
      return
    }
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
    session.handleBinary(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  }
  ws.on('message', onMessage)
  const cleanup = (): void => {
    ws.off('message', onMessage)
    if (deviceId && pcmConnections.get(deviceId) === ws) pcmConnections.delete(deviceId)
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
  return cleanup
}

/** TTS 音频下发：有原生直连走它（原生直接写 AudioTrack，不经 JS）；否则回退 JS 主连接。 */
function sendAudioTo(deviceId: string | null, jsWs: WebSocket, bytes: Uint8Array): void {
  const pcm = deviceId ? pcmConnections.get(deviceId) : undefined
  const target = pcm && pcm.readyState === WebSocket.OPEN ? pcm : jsWs
  if (target.readyState === WebSocket.OPEN) target.send(Buffer.from(bytes))
}

/**
 * WebSocket 语音 controller：只负责连接生命周期、帧路由、心跳，
 * 业务编排交给 VoiceSessionService。
 * 会话与连接解耦：同一 deviceId 的多个连接复用同一个 VoiceSessionService 实例
 * （重连/重唤醒保留对话记忆与待选歌单），连接断开只标记 inactive，
 * 仅 session.end 才从注册表移除并销毁会话。
 */
export function createVoiceConnection(ws: WebSocket, req: IncomingMessage, deps: VoiceControllerDeps): () => void {
  // 原生 PCM 直连上报连接：只喂音频帧，不参与 session/事件绑定
  if (queryParam(req, 'role') === 'pcm') return createPcmUploadConnection(ws, req)
  const { config, data } = deps
  const deviceId = deviceIdFromRequest(req)

  const send = (event: ServerEvent): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
  }
  const sendAudio = (bytes: Uint8Array): void => {
    // 播报期 JS 线程被 TTS 处理占满→weex 回调全失效，故 TTS 音频优先走原生直连，不经 JS；
    // 没有原生直连（H5/旧基座）才回退 JS 主连接。
    sendAudioTo(deviceId, ws, bytes)
  }
  /** 当前会话绑定的 socket；旧连接滞后断开时据此判断是否需要清会话 */
  let boundWs: WebSocket | null = null

  const makeService = (): VoiceSessionService =>
    new VoiceSessionService({
      // 语音配置（地址/密钥/模型/参数）一律来自客户端 session.start.voice，经 resolveCapabilityConfig 展开
      resolveVoice: (voice) => resolveCapabilityConfig(voice, config),
      createAsr,
      createTts,
      agentFactory: (llm, lang, timezone, locationProvider, memoryStore, memoryContext, requestLocation, getNowPlaying, autoMemory, mcpServers, autoLearnEngine, promptAddon) =>
        createAgentService(
          { llm, timeZone: timezone },
          lang,
          locationProvider,
          memoryStore,
          memoryContext,
          requestLocation,
          getNowPlaying,
          autoMemory,
          mcpServers,
          autoLearnEngine,
          promptAddon
        ),
      data,
      correctionSyncer: deps.correctionSyncer,
      skillModules: deps.skillModules,
      // 内容能力装配：工厂由 service/content/assembly 提供，注入核心。
      contentSourceFactory,
      contentResolverFactory,
      contentExecutorFactory,
      contentDashDeps,
      send,
      sendAudio,
      asrEndpointMs: config.asr.endpointMs,
      // 自动记忆（抽取 + 摘要）：合并阈值/频率来自网关配置（可经环境变量覆盖），不写死在逻辑里
      consolidateThreshold: config.memory.consolidateThreshold,
      consolidateEvery: config.memory.consolidateEvery,
      deviceId,
      onEnded: deviceId ? () => removeSession(deviceId) : undefined,
      config,
    })

  // 按 deviceId 复用会话；无 deviceId（旧客户端）则每连接独立会话、不复用。
  const session: VoiceSessionService = deviceId
    ? (getSession(deviceId) ?? (() => {
        const s = makeService()
        setSession(deviceId, s)
        return s
      })())
    : makeService()
  // 重连复用旧会话时，收发闭包必须指向当前存活的 socket
  session.bindTransport(send, sendAudio)
  // 记录当前绑定的 socket：旧连接若滞后断开，不应再清掉已切到新连接的会话
  boundWs = ws

  // 【2026-11-21 移除 ping-pong 主动 terminate —— 播报卡死根因】
  // 原逻辑：每 15s 发 ping，连续两次没收到 pong 就 ws.terminate()。但 App 端用
  // uni.connectSocket（DCloud），不保证响应标准 WS ping 帧；播报期 JS 线程忙时 pong
  // 回调更容易延迟 → 网关误判连接已死，在连接存活约 45-48s 时 terminate（真机铁证：
  // 播报中途 Socket CONNRESET/Connection reset by peer，@48.242s，随后 tts.idle 全丢、
  // 界面卡「正在播报/正在听」）。语音助手是长连接，宁可 keep 着也不要误杀：
  // 连接存活交给 TCP keepalive，断连由 onclose/onerror 自然处理，前端已有自动重连。
  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      session.handleBinary(chunk)
    } else {
      session.handleText(data.toString())
    }
  }
  const cleanup = (): void => {
    // 仅当本连接仍是会话当前绑定的 socket 才清掉会话状态；
    // 若已重连到新 socket，旧连接的延迟 close 不得误伤正在使用的新会话。
    if (boundWs === ws) {
      boundWs = null
      session.close()
    }
  }

  ws.on('message', onMessage)
  ws.on('close', cleanup)
  ws.on('error', cleanup)

  return cleanup
}
