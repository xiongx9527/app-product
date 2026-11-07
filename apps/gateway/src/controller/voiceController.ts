import { WebSocket, type RawData } from 'ws'
import { createAgentService } from '../service/agentService'
import { createAsr } from '../asr'
import { createTts } from '../tts'
import { VoiceSessionService } from '../service/voiceSessionService'
import type { GatewayConfig } from '../config'
import type { DataService } from '../service/dataService'
import type { ServerEvent } from '../protocol'

export interface VoiceControllerDeps {
  config: GatewayConfig
  data: DataService
}

/**
 * WebSocket 语音 controller：只负责连接生命周期、帧路由、心跳，
 * 业务编排交给 VoiceSessionService。
 */
export function createVoiceConnection(ws: WebSocket, deps: VoiceControllerDeps): () => void {
  const { config, data } = deps
  const session: VoiceSessionService = new VoiceSessionService({
    agentFactory: (lang, timezone, locationProvider, reverseGeocoder, musicSource, emit) =>
      createAgentService(
        { ...config, timeZone: timezone },
        lang,
        locationProvider,
        reverseGeocoder,
        musicSource,
        emit
      ),
    asr: createAsr(config),
    tts: createTts(config),
    data,
    send: (event: ServerEvent) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event))
    },
    sendAudio: (bytes) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(bytes))
    },
    asrEndpointMs: config.asr.endpointMs,
    tiandituTk: config.tiandituTk,
  })

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
    session.close()
  }

  ws.on('pong', onPong)
  ws.on('message', onMessage)
  ws.on('close', cleanup)
  ws.on('error', cleanup)

  return cleanup
}
