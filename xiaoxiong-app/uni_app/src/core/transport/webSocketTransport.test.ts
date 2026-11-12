import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { WebSocketTransport } from './webSocketTransport'
import { resolveGatewayUrl, resolveGatewayHttpBase } from './webSocketTransport'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

// 可控的 WebSocket 桩：建连即 OPEN，onopen / onmessage 由测试手动触发，
// 用来驱动 transport 的 onEvent 监听分发，验证「订阅→反订阅」是否真正生效。
class MockWebSocket {
  static OPEN = 1
  static last: MockWebSocket | null = null
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  // 初始为 CONNECTING(0)：让 transport 走正常 Promise 分支（而非命中「已 OPEN 提前返回」），
  // 这样 onopen 处理器会被注册、再由测试手动触发，模拟真实浏览器建连回调。
  readyState = 0
  binaryType = ''
  url: string
  constructor(url: string) {
    MockWebSocket.last = this
    this.url = url
  }
  send(): void {
    /* noop */
  }
  close(): void {
    /* noop */
  }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket)
})

describe('WebSocketTransport.onEvent 反订阅（HMR 重挂载双音频根因回归）', () => {
  it('反订阅后该监听不再收到事件，避免重复挂载叠加重复处理', async () => {
    const transport = new WebSocketTransport()
    const a = vi.fn()
    const b = vi.fn()
    // 模拟一次挂载：useAssistant 注册两个订阅（onEvent 只是其中之一）
    const offA = transport.onEvent(a)
    transport.onEvent(b)

    // 先拿到建连 promise，再手动触发 onopen（transport 已注册好处理器），最后 await
    const p = transport.connect('wake')
    // createSocket 现为异步：先让 socket 实例在本宏任务里建出来，再触发 onopen
    await new Promise((r) => setTimeout(r, 0))
    MockWebSocket.last!.onopen!()
    await p

    const evt = JSON.stringify({ type: 'asr.partial', text: '小熊小熊' })
    MockWebSocket.last!.onmessage!({ data: evt })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)

    // 模拟 onUnmounted 清理：移除 A（旧代码从不调用这一步，导致 HMR 叠加 A'）
    offA()

    MockWebSocket.last!.onmessage!({ data: evt })
    expect(a).toHaveBeenCalledTimes(1) // A 已移除，不再收到
    expect(b).toHaveBeenCalledTimes(2) // B 不受影响，仍正常收到
  })

  it('同一传输反复「挂载→卸载」不会让事件被处理多遍', async () => {
    const transport = new WebSocketTransport()
    const seen: string[] = []

    const p = transport.connect('wake')
    await new Promise((r) => setTimeout(r, 0))
    MockWebSocket.last!.onopen!()
    await p

    // 连续三次挂载/卸载（模拟 HMR 反复重挂载），每次都注册后立刻反订阅
    for (let i = 0; i < 3; i += 1) {
      const fn = (e: { type: string }) => seen.push(`${i}:${e.type}`)
      const off = transport.onEvent(fn)
      off()
    }
    const evt = JSON.stringify({ type: 'tts.start' })
    MockWebSocket.last!.onmessage!({ data: evt })
    // 全部已反订阅，任何事件都不应被处理
    expect(seen).toHaveLength(0)
  })
})

describe('resolveGatewayUrl / resolveGatewayHttpBase（网关地址，统一来源 VITE_GATEWAY_WS_URL）', () => {
  it('VITE_GATEWAY_WS_URL 优先', () => {
    vi.stubEnv('VITE_GATEWAY_WS_URL', 'ws://192.168.1.100:8787/ws')
    expect(resolveGatewayUrl()).toBe('ws://192.168.1.100:8787/ws')
    expect(resolveGatewayHttpBase()).toBe('http://192.168.1.100:8787')
  })

  it('wss:// → https://', () => {
    vi.stubEnv('VITE_GATEWAY_WS_URL', 'wss://gw.example.com/ws')
    expect(resolveGatewayHttpBase()).toBe('https://gw.example.com')
  })

  it('未注入时回退默认本机地址', () => {
    vi.stubEnv('VITE_GATEWAY_WS_URL', '')
    expect(resolveGatewayUrl()).toBe('ws://127.0.0.1:8787/ws')
    expect(resolveGatewayHttpBase()).toBe('http://127.0.0.1:8787')
  })
})
