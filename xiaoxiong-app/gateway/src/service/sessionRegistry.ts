import type { VoiceSessionService } from './voiceSessionService'

/**
 * 设备会话注册表：按稳定 deviceId 维护一次网关进程内的活跃语音会话。
 * 会话与 WebSocket 连接解耦——同一设备的断线重连/重唤醒复用同一会话，
 * 保留 LLM 对话记忆与待选歌单，不再因连接生命周期而失忆。
 *
 * 不在本次范围：跨网关重启的会话持久化（需落库），由 data 服务另议。
 */

const registry = new Map<string, VoiceSessionService>()

export function getSession(deviceId: string): VoiceSessionService | undefined {
  return registry.get(deviceId)
}

export function setSession(deviceId: string, session: VoiceSessionService): void {
  registry.set(deviceId, session)
}

export function removeSession(deviceId: string): void {
  registry.delete(deviceId)
}
