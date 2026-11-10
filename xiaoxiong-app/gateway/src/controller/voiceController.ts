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

export interface VoiceControllerDeps {
  config: GatewayConfig
  data: DataService
}

/** 从 WS 握手请求里取 deviceId（客户端随连接 URL query 上报）；缺省空表示旧客户端。 */
function deviceIdFromRequest(req: IncomingMessage): string | null {
  const raw = req.url ?? ''
  const q = raw.indexOf('?')
  if (q === -1) return null
  const id = new URLSearchParams(raw.slice(q + 1)).get('deviceId')
  return id && id.length > 0 ? id : null
}

/**
 * WebSocket 语音 controller：只负责连接生命周期、帧路由、心跳，
 * 业务编排交给 VoiceSessionService。
 * 会话与连接解耦：同一 deviceId 的多个连接复用同一个 VoiceSessionService 实例
 * （重连/重唤醒保留对话记忆与待选歌单），连接断开只标记 inactive，
 * 仅 session.end 才从注册表移除并销毁会话。
 */
export function createVoiceConnection(ws: WebSocket, req: IncomingMessage, deps: VoiceControllerDeps): () => void {
  const { config, data } = deps
  const deviceId = deviceIdFromRequest(req)

  const send = (event: ServerEvent): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
  }
  const sendAudio = (bytes: Uint8Array): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(bytes))
  }
  /** 当前会话绑定的 socket；旧连接滞后断开时据此判断是否需要清会话 */
  let boundWs: WebSocket | null = null

  const makeService = (): VoiceSessionService =>
    new VoiceSessionService({
      // 语音配置（地址/密钥/模型/参数）一律来自客户端 session.start.voice，经 resolveCapabilityConfig 展开
      resolveVoice: (voice) => resolveCapabilityConfig(voice, config),
      createAsr,
      createTts,
      agentFactory: (llm, lang, timezone, locationProvider, getMusicSource, emit, memoryStore, memoryContext, requestLocation) =>
        createAgentService(
          { llm, timeZone: timezone },
          lang,
          locationProvider,
          getMusicSource,
          emit,
          memoryStore,
          memoryContext,
          requestLocation
        ),
      data,
      send,
      sendAudio,
      asrEndpointMs: config.asr.endpointMs,
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

  let alive = true
  const onPong = (): void => {
    alive = true
  }
  const pingTimer = setInterval(() => {
    if (!alive) {
      ws.terminate()
      return
    }
    alive = false
    try {
      ws.ping()
    } catch {
      /* 连接已坏，下个周期 terminate */
    }
  }, 15000)

  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      session.handleBinary(chunk)
    } else {
      session.handleText(data.toString())
    }
  }
  const cleanup = (): void => {
    clearInterval(pingTimer)
    // 仅当本连接仍是会话当前绑定的 socket 才清掉会话状态；
    // 若已重连到新 socket，旧连接的延迟 close 不得误伤正在使用的新会话。
    if (boundWs === ws) {
      boundWs = null
      session.close()
    }
  }

  ws.on('pong', onPong)
  ws.on('message', onMessage)
  ws.on('close', cleanup)
  ws.on('error', cleanup)

  return cleanup
}
