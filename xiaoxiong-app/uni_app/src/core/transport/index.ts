export { WebSocketTransport, resolveGatewayHttpBase } from './webSocketTransport'
export type { AssistantTransport, ServerEvent } from './types'

import { WebSocketTransport } from './webSocketTransport'
import type { AssistantTransport } from './types'

/** 创建真实网关传输（H5 走浏览器 WebSocket 直连 Node 网关 /ws）。 */
export function createTransport(maxReconnectAttempts = 5): AssistantTransport {
  return new WebSocketTransport(undefined, 'zh-CN', maxReconnectAttempts)
}
