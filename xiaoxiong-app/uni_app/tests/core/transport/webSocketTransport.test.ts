import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { WebSocketTransport } from '../../../src/core/transport/webSocketTransport'
import { resolveGatewayUrl, resolveGatewayHttpBase, resolveMcpUrl } from '../../../src/core/transport/webSocketTransport'
import { appConfig } from '../../../src/core/config'

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

  it('media.report 报表事件原样下发（结构化 blocks 不被当成普通文本吞掉）', async () => {
    const transport = new WebSocketTransport()
    const seen: unknown[] = []
    transport.onEvent((e) => seen.push(e))

    const p = transport.connect('wake')
    await new Promise((r) => setTimeout(r, 0))
    MockWebSocket.last!.onopen!()
    await p

    const report = {
      type: 'media.report',
      title: '各年级统计',
      blocks: [
        { type: 'table', columns: [{ name: '年级', value: '年级' }], rows: [{ 年级: '一年级' }] },
        { type: 'image', url: '/api/chart/image/abc' },
      ],
    }
    MockWebSocket.last!.onmessage!({ data: JSON.stringify(report) })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(report)
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

describe('resolveMcpUrl（固定 MCP 地址 = 服务设置地址 + /mcp/ 或 /mcp/sse）', () => {
  const original = appConfig.voice.builtin.url
  const originalTransport = appConfig.mcp.transport
  afterEach(() => {
    appConfig.voice.builtin.url = original
    appConfig.mcp.transport = originalTransport
  })

  it('沿用配置地址的协议/host/端口，只拼固定路径', () => {
    appConfig.voice.builtin.url = 'http://127.0.0.1:9529'
    expect(resolveMcpUrl()).toBe('http://127.0.0.1:9529/mcp/')
  })

  it('公网地址同样只拼路径', () => {
    appConfig.voice.builtin.url = 'https://25946kt718.goho.co'
    expect(resolveMcpUrl()).toBe('https://25946kt718.goho.co/mcp/')
  })

  it('去掉配置地址末尾的斜杠，避免双斜杠', () => {
    appConfig.voice.builtin.url = 'https://gw.example.com/'
    expect(resolveMcpUrl()).toBe('https://gw.example.com/mcp/')
  })

  it('服务地址为空时返回空串（不下发固定 server）', () => {
    appConfig.voice.builtin.url = ''
    expect(resolveMcpUrl()).toBe('')
  })

  it('传输协议切成 sse：路径改为 /mcp/sse', () => {
    appConfig.voice.builtin.url = 'https://gw.example.com'
    appConfig.mcp.transport = 'sse'
    expect(resolveMcpUrl()).toBe('https://gw.example.com/mcp/sse')
  })

  it('传输协议为 http（默认）：路径为 /mcp/', () => {
    appConfig.voice.builtin.url = 'https://gw.example.com'
    appConfig.mcp.transport = 'http'
    expect(resolveMcpUrl()).toBe('https://gw.example.com/mcp/')
  })
})

describe('session.start 的 MCP server 下发随总开关', () => {
  const originalUrl = appConfig.voice.builtin.url
  const originalEnabled = appConfig.mcp.enabled
  const originalTransport = appConfig.mcp.transport
  afterEach(() => {
    appConfig.voice.builtin.url = originalUrl
    appConfig.mcp.enabled = originalEnabled
    appConfig.mcp.transport = originalTransport
  })

  async function captureStartServers(): Promise<unknown[]> {
    // 在 MockWebSocket 构造时就挂 send 拦截：connect() 建连成功即会发 session.start，
    // 若等 connect 后再挂就错过那一条，startSession 在已 OPEN 时也不再发第二条。
    let sent: any
    let instance: MockWebSocket
    const OrigWS = MockWebSocket
    const SpyWS = class extends OrigWS {
      constructor(...args: any[]) {
        super(...args)
        this.readyState = 1 // Mock 建连即 OPEN，sendJson 才会真正发送
        instance = this
      }
      override send(data: string): void { sent = JSON.parse(data) }
    }
    vi.stubGlobal('WebSocket', SpyWS)
    const transport = new WebSocketTransport()
    const p = transport.connect('wake')
    await new Promise((r) => setTimeout(r, 0))
    instance!.onopen!()
    await p
    return sent?.mcp?.servers ?? []
  }

  it('开关开启（默认）：下发指向服务地址 /mcp/ 的 http 固定 server', async () => {
    appConfig.voice.builtin.url = 'https://gw.example.com'
    appConfig.mcp.enabled = true
    appConfig.mcp.transport = 'http'
    const servers = await captureStartServers()
    expect(servers).toHaveLength(1)
    expect((servers[0] as { url: string }).url).toBe('https://gw.example.com/mcp/')
    expect((servers[0] as { transport: string }).transport).toBe('http')
  })

  it('传输协议切成 sse：下发 /mcp/sse + transport=sse', async () => {
    appConfig.voice.builtin.url = 'https://gw.example.com'
    appConfig.mcp.enabled = true
    appConfig.mcp.transport = 'sse'
    const servers = await captureStartServers()
    expect((servers[0] as { url: string }).url).toBe('https://gw.example.com/mcp/sse')
    expect((servers[0] as { transport: string }).transport).toBe('sse')
  })

  it('开关关闭：servers 为空，网关不连任何 MCP', async () => {
    appConfig.voice.builtin.url = 'https://gw.example.com'
    appConfig.mcp.enabled = false
    expect(await captureStartServers()).toEqual([])
  })
})
