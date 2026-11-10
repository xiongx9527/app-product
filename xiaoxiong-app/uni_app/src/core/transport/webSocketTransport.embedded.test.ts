import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 内嵌网关（APP-PLUS）下，connect 必须先解析原生回传的动态端口地址，
// 再拿它建连。这里把 gatewayBootstrap 打桩成「内嵌 + 固定地址」，
// 验证 WebSocket 确实用上动态端口，而不是回退默认地址。
vi.mock('./gatewayBootstrap', () => ({
  isEmbeddedGateway: () => true,
  getGatewayWsUrl: vi.fn(() => Promise.resolve('ws://127.0.0.1:4321/ws')),
}))

import { WebSocketTransport } from './webSocketTransport'

/** 最小可手动触发的 WebSocket 替身，仅覆盖传输层用到的接口。 */
class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  url: string
  readyState = 0 // CONNECTING
  binaryType = ''
  onopen: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  sent: unknown[] = []

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send(data: unknown) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
}

describe('WebSocketTransport.connect（内嵌网关动态端口）', () => {
  const originalWs = (globalThis as unknown as { WebSocket?: unknown }).WebSocket

  beforeEach(() => {
    FakeWebSocket.instances = []
    ;(globalThis as unknown as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    vi.clearAllMocks()
  })

  afterEach(() => {
    ;(globalThis as unknown as { WebSocket?: unknown }).WebSocket = originalWs
  })

  it('内嵌网关：connect 解析动态端口并带 deviceId 建连', async () => {
    const transport = new WebSocketTransport()
    const ready = transport.connect('dialog')
    // 等 getGatewayWsUrl() 的微任务 + 构造 WebSocket 完成
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(FakeWebSocket.instances.length).toBe(1)
    const ws = FakeWebSocket.instances[0]
    expect(ws.url).toContain('ws://127.0.0.1:4321/ws')
    expect(ws.url).toContain('deviceId=')

    ws.fireOpen()
    await ready
    expect(transport.isConnected()).toBe(true)
  })

  it('每次 connect 都重新解析动态端口（应对首次启动端口文件竞态/重连自愈）', async () => {
    const { getGatewayWsUrl } = await import('./gatewayBootstrap')
    const transport = new WebSocketTransport()
    const first = transport.connect('dialog')
    await new Promise((resolve) => setTimeout(resolve, 0))
    FakeWebSocket.instances[0]?.fireOpen()
    await first

    const afterFirst = (getGatewayWsUrl as ReturnType<typeof vi.fn>).mock.calls.length
    expect(afterFirst).toBe(1)

    // 外部再次 connect：每次都会重新解析（不缓存），保证首启时 gateway.url
    // 尚未写好、或端口变化重连时，能拿到最新动态地址。
    const second = transport.connect('dialog')
    await new Promise((resolve) => setTimeout(resolve, 0))
    FakeWebSocket.instances[FakeWebSocket.instances.length - 1]?.fireOpen()
    await second
    expect((getGatewayWsUrl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      afterFirst + 1,
    )
  })
})
