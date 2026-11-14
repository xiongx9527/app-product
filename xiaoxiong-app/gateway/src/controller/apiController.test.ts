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

describe('apiController：/api/admin/config（设置页保存配置落库 SQLite）', () => {
  const cfg = { version: 1, mode: 'byok', language: 'zh-CN', voice: { provider: 'builtin', builtin: { url: 'http://127.0.0.1:9529', asrModel: 'sensevoice-small' } } }

  it('POST 落库、GET 读回整份配置', async () => {
    const { api, query } = makeApi()
    const post = await api({ method: 'POST', pathname: '/api/admin/config', query, body: cfg })
    expect(post.status).toBe(200)
    expect(asBody(post.body).ok).toBe(true)
    const get = await api({ method: 'GET', pathname: '/api/admin/config', query, body: undefined })
    expect(get.status).toBe(200)
    expect(asBody(get.body).config).toEqual(cfg)
  })

  it('重复保存按 deviceId 覆盖更新，不堆积历史行', async () => {
    const { api, query } = makeApi()
    await api({ method: 'POST', pathname: '/api/admin/config', query, body: cfg })
    const cfg2 = { ...cfg, language: 'en-US' }
    await api({ method: 'POST', pathname: '/api/admin/config', query, body: cfg2 })
    const get = await api({ method: 'GET', pathname: '/api/admin/config', query, body: undefined })
    expect((asBody(get.body).config as typeof cfg).language).toBe('en-US')
  })

  it('按 deviceId 隔离：不同设备各存各的', async () => {
    const db = createDb(':memory:')
    const api = createApiController(createDataService(db), API_CONFIG)
    await api({ method: 'POST', pathname: '/api/admin/config', query: new URLSearchParams('deviceId=a'), body: { language: 'zh-CN' } })
    await api({ method: 'POST', pathname: '/api/admin/config', query: new URLSearchParams('deviceId=b'), body: { language: 'en-US' } })
    const a = await api({ method: 'GET', pathname: '/api/admin/config', query: new URLSearchParams('deviceId=a'), body: undefined })
    const b = await api({ method: 'GET', pathname: '/api/admin/config', query: new URLSearchParams('deviceId=b'), body: undefined })
    expect((asBody(a.body).config as { language: string }).language).toBe('zh-CN')
    expect((asBody(b.body).config as { language: string }).language).toBe('en-US')
  })

  it('缺 deviceId 返回 400；未保存过的设备 GET 返回 config:null', async () => {
    const { api } = makeApi()
    const noId = await api({ method: 'POST', pathname: '/api/admin/config', query: new URLSearchParams(), body: cfg })
    expect(noId.status).toBe(400)
    const empty = await api({ method: 'GET', pathname: '/api/admin/config', query: new URLSearchParams('deviceId=never'), body: undefined })
    expect(asBody(empty.body).config).toBe(null)
  })

  it('body 非对象返回 400（脏数据不入库）', async () => {
    const { api, query } = makeApi()
    const arr = await api({ method: 'POST', pathname: '/api/admin/config', query, body: [1, 2, 3] })
    expect(arr.status).toBe(400)
    const nul = await api({ method: 'POST', pathname: '/api/admin/config', query, body: null })
    expect(nul.status).toBe(400)
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

  it('百炼：前端带 url 时按该地址拉模型，而非网关默认云端地址', async () => {
    const { api } = makeApi()
    let seenUrl = ''
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/compatible-mode/v1/models')) {
        seenUrl = u
        return new Response(JSON.stringify({ data: [{ id: 'maas-model' }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const query = new URLSearchParams('provider=dashscope&apiKey=k&url=https://llm-x.maas.aliyuncs.com')
    const res = await api({ method: 'GET', pathname: '/api/admin/llm-models', query, body: null })
    expect(res.status).toBe(200)
    expect(asBody(res.body).models).toEqual(['maas-model'])
    expect(seenUrl).toContain('https://llm-x.maas.aliyuncs.com/compatible-mode/v1/models')
  })

  it('百炼：不带 url 时回退网关默认地址（旧行为不变）', async () => {
    const { api } = makeApi()
    let seenUrl = ''
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/compatible-mode/v1/models')) {
        seenUrl = u
        return new Response(JSON.stringify({ data: [{ id: 'cloud-model' }] }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const query = new URLSearchParams('provider=dashscope&apiKey=k')
    const res = await api({ method: 'GET', pathname: '/api/admin/llm-models', query, body: null })
    expect(res.status).toBe(200)
    expect(asBody(res.body).models).toEqual(['cloud-model'])
    expect(seenUrl).toContain('https://dashscope.aliyuncs.com/compatible-mode/v1/models')
  })
})

describe('apiController：/api/admin/voice-models（ASR / TTS 模型下拉，实时目录 + 清单兜底）', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('内置 ASR：实时拉 9529 /voice/v1/models 并按 type=STT 过滤，合并固定兜底', async () => {
    const { api } = makeApi()
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/voice/v1/models')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'sensevoice-small', type: 'STT' },
              { id: 'edge-tts', type: 'TTS' },
              { id: 'some-upstream-stt', type: 'STT' },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const query = new URLSearchParams('provider=builtin&capability=asr')
    const res = await api({ method: 'GET', pathname: '/api/admin/voice-models', query, body: null })
    expect(res.status).toBe(200)
    const models = asBody(res.body).models as string[]
    // 固定兜底 sensevoice-small + 上游 some-upstream-stt，edge-tts（TTS）被过滤掉。
    expect(models).toContain('sensevoice-small')
    expect(models).toContain('some-upstream-stt')
    expect(models).not.toContain('edge-tts')
  })

  it('内置 TTS：网关用自身配置地址中转，前端不传地址', async () => {
    const { api } = makeApi()
    let seenUrl = ''
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('/voice/v1/models')) {
        seenUrl = u
        return new Response(
          JSON.stringify({ object: 'list', data: [{ id: 'edge-tts', type: 'TTS' }] }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const query = new URLSearchParams('provider=builtin&capability=tts')
    const res = await api({ method: 'GET', pathname: '/api/admin/voice-models', query, body: null })
    expect(res.status).toBe(200)
    expect(seenUrl).toContain('http://127.0.0.1:9529/voice/v1/models')
    expect(asBody(res.body).models).toContain('edge-tts')
  })

  it('内置：9529 拉不到时回退固定清单，保证非空', async () => {
    const { api } = makeApi()
    globalThis.fetch = (async () => new Response('err', { status: 500 })) as unknown as typeof fetch
    const query = new URLSearchParams('provider=builtin&capability=asr')
    const res = await api({ method: 'GET', pathname: '/api/admin/voice-models', query, body: null })
    expect(res.status).toBe(200)
    expect(asBody(res.body).models).toEqual(['sensevoice-small'])
  })

  it('百炼：无匿名枚举接口，直接返回官方清单兜底（ASR）', async () => {
    const { api } = makeApi()
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const query = new URLSearchParams('provider=dashscope&capability=asr')
    const res = await api({ method: 'GET', pathname: '/api/admin/voice-models', query, body: null })
    expect(res.status).toBe(200)
    const models = asBody(res.body).models as string[]
    expect(models).toContain('paraformer-realtime-v2')
    expect(models).toContain('qwen3-asr-flash')
    // 百炼走兜底清单，不发网络请求。
    expect(called).toBe(false)
  })

  it('百炼 TTS：返回官方 CosyVoice / Qwen-TTS 清单', async () => {
    const { api } = makeApi()
    const query = new URLSearchParams('provider=dashscope&capability=tts')
    const res = await api({ method: 'GET', pathname: '/api/admin/voice-models', query, body: null })
    expect(res.status).toBe(200)
    const models = asBody(res.body).models as string[]
    expect(models).toContain('cosyvoice-v3-flash')
    expect(models).toContain('qwen3-tts-flash')
  })

  it('provider / capability 非法返回 400', async () => {
    const { api } = makeApi()
    const badProvider = await api({ method: 'GET', pathname: '/api/admin/voice-models', query: new URLSearchParams('provider=x&capability=asr'), body: null })
    expect(badProvider.status).toBe(400)
    const badCap = await api({ method: 'GET', pathname: '/api/admin/voice-models', query: new URLSearchParams('provider=builtin&capability=x'), body: null })
    expect(badCap.status).toBe(400)
  })
})
