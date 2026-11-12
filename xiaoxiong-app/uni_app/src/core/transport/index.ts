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
  // HMR / 重复挂载场景下，旧 transport 可能因其 onUnmounted 未被触发而仍持有活跃 WS 连接，
  // 导致同一份事件/音频被多个残留实例各处理一遍（听感「双声 / 回声」）。
  // 建新实例前先关掉旧实例的 WS，保证全局至多一条活跃连接，从根上杜绝叠加；
  // 旧的 useAssistant 闭包即便因 HMR 未卸载而残留，其 transport 已断开、不会再收到事件。
  if (activeTransport) {
    try {
      activeTransport.close()
    } catch {
      // 已关闭的实例忽略
    }
  }
  activeTransport = new WebSocketTransport(undefined, 'zh-CN', maxReconnectAttempts)
  return activeTransport
}

/** 取当前活跃传输实例；无连接时返回 null（调用方退化为下一轮会话生效）。 */
export function getActiveTransport(): AssistantTransport | null {
  return activeTransport
}
