import { describe, it, expect } from 'vitest'
import { createDb } from '../db/client'
import { createDataService } from '../service/dataService'
import { generateRsaKeyPair } from '../crypto'

const keys = generateRsaKeyPair()

function makeData() {
  const db = createDb(':memory:')
  return createDataService(db, keys.publicKey, keys.privateKey)
}

describe('voice config 持久化（SQLite）', () => {
  it('无记录时回退默认内置配置', async () => {
    const data = makeData()
    const c = await data.getVoiceConfig('dev-1')
    expect(c.provider).toBe('builtin')
    expect(c.url).toBe('http://127.0.0.1:9529')
    expect(c.apiKey).toBe('')
  })

  it('保存后可按设备读取，provider / url / apiKey 完整还原', async () => {
    const data = makeData()
    await data.saveVoiceConfig('dev-1', {
      provider: 'dashscope',
      url: 'https://dashscope.aliyuncs.com',
      apiKey: 'sk-abc',
    })
    const c = await data.getVoiceConfig('dev-1')
    expect(c.provider).toBe('dashscope')
    expect(c.url).toBe('https://dashscope.aliyuncs.com')
    expect(c.apiKey).toBe('sk-abc')
  })

  it('再次保存覆盖上一次选择', async () => {
    const data = makeData()
    await data.saveVoiceConfig('dev-1', { provider: 'builtin', url: 'http://127.0.0.1:9529', apiKey: '' })
    await data.saveVoiceConfig('dev-1', {
      provider: 'dashscope',
      url: 'https://dashscope.aliyuncs.com',
      apiKey: 'sk-2',
    })
    const c = await data.getVoiceConfig('dev-1')
    expect(c.apiKey).toBe('sk-2')
  })

  it('不同设备互不干扰', async () => {
    const data = makeData()
    await data.saveVoiceConfig('dev-A', { provider: 'builtin', url: 'http://127.0.0.1:9529', apiKey: '' })
    await data.saveVoiceConfig('dev-B', { provider: 'dashscope', url: 'https://dashscope.aliyuncs.com', apiKey: 'sk-b' })
    expect((await data.getVoiceConfig('dev-A')).provider).toBe('builtin')
    expect((await data.getVoiceConfig('dev-B')).apiKey).toBe('sk-b')
  })
})
