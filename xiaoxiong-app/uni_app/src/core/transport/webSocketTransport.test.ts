import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveGatewayUrl, resolveGatewayHttpBase } from './webSocketTransport'

afterEach(() => {
  vi.unstubAllEnvs()
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
