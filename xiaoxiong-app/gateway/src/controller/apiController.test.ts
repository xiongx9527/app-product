import { describe, it, expect } from 'vitest'
import { createDb } from '../db/client'
import { createDataService } from '../service/dataService'
import { createApiController } from './apiController'
import { generateRsaKeyPair } from '../crypto'

const keys = generateRsaKeyPair()

function makeApi(deviceId: string | null = 'dev-1') {
  const db = createDb(':memory:')
  const data = createDataService(db, keys.publicKey, keys.privateKey)
  const api = createApiController(data)
  const query = new URLSearchParams(deviceId ? `deviceId=${deviceId}` : '')
  return { api, data, query }
}

const asBody = (b: unknown) => b as Record<string, unknown>

describe('apiController：设置接口挂在 /api/assistant 下', () => {
  it('POST /api/assistant/voice-config 持久化并返回保存结果', async () => {
    const { api, query } = makeApi()
    const res = await api({
      method: 'POST',
      pathname: '/api/assistant/voice-config',
      query,
      body: { provider: 'dashscope', url: 'https://dashscope.aliyuncs.com', apiKey: 'sk-1' },
    })
    expect(res.status).toBe(200)
    expect(asBody(res.body).voice).toMatchObject({ provider: 'dashscope', apiKey: 'sk-1' })
  })

  it('GET /api/assistant/voice-config 返回已保存配置', async () => {
    const { api, data, query } = makeApi()
    await data.saveVoiceConfig('dev-1', {
      provider: 'dashscope',
      url: 'https://dashscope.aliyuncs.com',
      apiKey: 'sk-1',
    })
    const res = await api({ method: 'GET', pathname: '/api/assistant/voice-config', query, body: undefined })
    expect(asBody(res.body)).toMatchObject({ provider: 'dashscope', apiKey: 'sk-1' })
  })

  it('GET /api/assistant/voice-config 缺 deviceId 返回 400', async () => {
    const { api, query } = makeApi(null)
    const res = await api({ method: 'GET', pathname: '/api/assistant/voice-config', query, body: undefined })
    expect(res.status).toBe(400)
  })

  it('通用数据接口仍在 /api 下（sessions / device-data）', async () => {
    const { api, query } = makeApi()
    const s = await api({ method: 'POST', pathname: '/api/sessions', query, body: { deviceId: 'dev-1' } })
    expect(s.status).toBe(201)
    const m = await api({ method: 'POST', pathname: '/api/device-data', query, body: { type: 'x', payload: {} } })
    expect(m.status).toBe(201)
  })

  it('长期记忆删除移到 /api/assistant/memories', async () => {
    const { api, data, query } = makeApi()
    await data.saveMemory('dev-1', 'a', 'b')
    const res = await api({ method: 'DELETE', pathname: '/api/assistant/memories', query, body: { key: 'a' } })
    expect(asBody(res.body).deleted).toBe(1)
  })
})
