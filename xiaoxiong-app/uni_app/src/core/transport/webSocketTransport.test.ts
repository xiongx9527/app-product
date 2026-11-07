import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { resolveGatewayHttpBase } from './webSocketTransport'
import { appConfig } from '@/core/config'

const original = appConfig.gatewayWsUrl
beforeEach(() => {
  appConfig.gatewayWsUrl = ''
})
afterAll(() => {
  appConfig.gatewayWsUrl = original
})

describe('resolveGatewayHttpBase（由网关 WS 地址派生 HTTP 基地址）', () => {
  it('ws://host:port/ws → http://host:port（去掉路径）', () => {
    appConfig.gatewayWsUrl = 'ws://192.168.1.100:8787/ws'
    expect(resolveGatewayHttpBase()).toBe('http://192.168.1.100:8787')
  })

  it('wss:// → https://', () => {
    appConfig.gatewayWsUrl = 'wss://gw.example.com/ws'
    expect(resolveGatewayHttpBase()).toBe('https://gw.example.com')
  })

  it('无路径时也能正确返回', () => {
    appConfig.gatewayWsUrl = 'ws://127.0.0.1:9000'
    expect(resolveGatewayHttpBase()).toBe('http://127.0.0.1:9000')
  })
})
