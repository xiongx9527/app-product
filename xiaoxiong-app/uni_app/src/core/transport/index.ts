export { WebSocketTransport, resolveGatewayHttpBase } from './webSocketTransport'
export { getGatewayWsUrl, isEmbeddedGateway } from './gatewayBootstrap'
export type { AssistantTransport, ServerEvent } from './types'

import { WebSocketTransport } from './webSocketTransport'
import type { AssistantTransport } from './types'

/**
 * 当前进程内活跃的传输实例（最近一次 createTransport 创建的）。
 * 设置页等没有 useAssistant 上下文的地方，靠它拿到已建立的连接去推送实时变更
 * （如播放源切换）。未建立连接时返回 undefined，调用方应据此退化为「下一次唤醒生效」。
 */
let activeTransport: AssistantTransport | null = null

/** 创建真实网关传输（H5 走浏览器 WebSocket 直连 Node 网关 /ws）。 */
export function createTransport(maxReconnectAttempts = 5): AssistantTransport {
  activeTransport = new WebSocketTransport(undefined, 'zh-CN', maxReconnectAttempts)
  return activeTransport
}

/** 取当前活跃传输实例；无连接时返回 null（调用方退化为下一轮会话生效）。 */
export function getActiveTransport(): AssistantTransport | null {
  return activeTransport
}
