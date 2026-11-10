import { describe, it, expect, afterEach } from 'vitest'
import { createDb } from '../db/client'
import { createDataService } from '../service/dataService'
import { createApiController } from './apiController'
import type { GatewayConfig } from '../config'

const API_CONFIG: Pick<GatewayConfig, 'voiceBuiltinUrl' | 'voiceDashscopeUrl'> = {
  voiceBuiltinUrl: 'http://127.0.0.1:9529',
  voiceDashscopeUrl: 'https://dashscope.aliyuncs.com',
}

function makeApi(deviceId: string | null = 'dev-1') {
  const db = createDb(':memory:')
  const data = createDataService(db)
  const api = createApiController(data, API_CONFIG)
  const query = new URLSearchParams(deviceId ? `deviceId=${deviceId}` : '')
  return { api, data, query }
}

const asBody = (b: unknown) => b as Record<string, unknown>

describe('apiController：设置接口挂在 /api/admin 下', () => {
  it('通用数据接口仍在 /api 下（sessions / command-logs）', async () => {
    const { api, query } = makeApi()
    const s = await api({ method: 'POST', pathname: '/api/sessions', query, body: { deviceId: 'dev-1' } })
    expect(s.status).toBe(201)
    const c = await api({ method: 'POST', pathname: '/api/command-logs', query, body: { command: '开灯', result: 'ok' } })
    expect(c.status).toBe(201)
  })

  it('长期记忆删除移到 /api/admin/memories', async () => {
    const { api, data, query } = makeApi()
    await data.saveMemory('dev-1', 'a', 'b')
    const res = await api({ method: 'DELETE', pathname: '/api/admin/memories', query, body: { key: 'a' } })
    expect(asBody(res.body).deleted).toBe(1)
  })
})

describe('apiController：/api/admin/llm-models（前端只传 provider，网关持有地址并中转）', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('内置：网关用自身配置的地址中转拉模型，前端不传地址', async () => {
    const { api } = makeApi()
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/llm/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const query = new URLSearchParams('provider=builtin')
    const res = await api({ method: 'GET', pathname: '/api/admin/llm-models', query, body: null })
    expect(res.status).toBe(200)
    expect(asBody(res.body).models).toEqual(['m1', 'm2'])
  })

  it('内置：把可选 api-key 透传给内置服务', async () => {
    const { api } = makeApi()
    let seenAuth = ''
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/llm/v1/models')) {
        seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const query = new URLSearchParams('provider=builtin&apiKey=secret')
    const res = await api({ method: 'GET', pathname: '/api/admin/llm-models', query, body: null })
    expect(res.status).toBe(200)
    expect(seenAuth).toBe('Bearer secret')
  })

  it('provider 非法返回 400', async () => {
    const { api } = makeApi()
    const query = new URLSearchParams('provider=unknown')
    const res = await api({ method: 'GET', pathname: '/api/admin/llm-models', query, body: null })
    expect(res.status).toBe(400)
  })

  it('网关未配置内置地址时返回 502', async () => {
    const db = createDb(':memory:')
    const data = createDataService(db)
    const api = createApiController(data, { voiceBuiltinUrl: '', voiceDashscopeUrl: 'https://dashscope.aliyuncs.com' })
    const query = new URLSearchParams('provider=builtin')
    const res = await api({ method: 'GET', pathname: '/api/admin/llm-models', query, body: null })
    expect(res.status).toBe(502)
  })
})
