import { WebSocket } from 'ws'
import { beforeAll, afterAll, it, expect } from 'vitest'
import { createGateway } from './server'
import type { ServerEvent } from './protocol'
import type { GatewayConfig } from './config'
import { generateRsaKeyPair, encryptWithPublicKey, decryptWithPrivateKey } from './crypto'
import { createDb } from './db/client'
import { deviceData } from './db/schema'
import { deviceDataMapper } from './mapper/deviceDataMapper'

// 落库加密用的第三对密钥（网关持有 db 公钥 + 私钥）。
const dbKeys = generateRsaKeyPair()

const base: GatewayConfig = {
  port: 8799,
  apiBase: '/api',
  paramEncrypt: false,
  rsaBackendPrivateKey: '',
  rsaFrontendPublicKey: '',
  timeZone: 'Asia/Shanghai',
  ws: { path: '/ws' },
  llm: { provider: 'stub', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5', apiKey: '', params: {} },
  asr: { provider: 'stub', baseUrl: 'http://127.0.0.1:9529', apiKey: '', endpointMs: 30, params: {} },
  tts: { provider: 'stub', baseUrl: 'http://127.0.0.1:9529', apiKey: '', params: {} },
  db: { path: ':memory:', publicKey: dbKeys.publicKey, privateKey: dbKeys.privateKey },
}

/** 100ms 方波人声帧：客户端持续上行后，静音帧会被 VAD 丢掉，测试得送人声。 */
function loudFrame(samples = 1600): Buffer {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i += 1) pcm[i] = i % 2 === 0 ? 12000 : -12000
  return Buffer.from(pcm.buffer)
}

let gateway: ReturnType<typeof createGateway>
beforeAll(() => {
  gateway = createGateway(base)
  gateway.listen()
})
afterAll(() => {
  gateway.httpServer.close()
})

it('voice flow: asr.final -> llm.delta* -> llm.done -> tts.start/end + audio', async () => {
  const events: ServerEvent[] = []
  const audio: Uint8Array[] = []
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${base.port}/ws`)
    const timer = setTimeout(() => reject(new Error('timeout waiting for voice flow')), 8000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session.start', sessionId: 's1', lang: 'zh-CN' }))
      // 客户端现在持续上行，静音帧会被 VAD 丢掉，所以这里送两帧人声（连续两帧才确认开口）
      ws.send(loudFrame())
      ws.send(loudFrame())
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) audio.push(new Uint8Array(data as ArrayBuffer))
      else events.push(JSON.parse(data.toString()) as ServerEvent)
      const types = events.map((e) => e.type)
      if (types.includes('llm.done') && types.includes('tts.end')) {
        clearTimeout(timer)
        ws.close()
        resolve()
      }
    })
    ws.on('error', reject)
  })
  const types = events.map((e) => e.type)
  expect(types).toContain('asr.final')
  expect(types).toContain('llm.delta')
  expect(types).toContain('llm.done')
  expect(types).toContain('tts.start')
  expect(types).toContain('tts.end')
  expect(audio.length).toBeGreaterThan(0)
}, 12000)

it('REST health', async () => {
  const res = await fetch(`http://127.0.0.1:${base.port}/api/health`)
  expect(res.status).toBe(200)
  expect((await res.json() as { ok: boolean }).ok).toBe(true)
})

it('REST create + list session', async () => {
  const created = await fetch(`http://127.0.0.1:${base.port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'd1' }),
  })
  expect(created.status).toBe(201)
  const list = await fetch(`http://127.0.0.1:${base.port}/api/sessions?deviceId=d1`)
  expect(list.status).toBe(200)
  const rows = (await list.json()) as unknown[]
  expect(rows.length).toBeGreaterThan(0)
})

// 加密测试用的两对密钥：后端对（网关持有私钥）+ 前端对（网关持有前端公钥）。
const backendKeys = generateRsaKeyPair()
const frontendKeys = generateRsaKeyPair()
const encConfig: GatewayConfig = {
  ...base,
  port: 8800,
  paramEncrypt: true,
  rsaBackendPrivateKey: backendKeys.privateKey,
  rsaFrontendPublicKey: frontendKeys.publicKey,
}
let encGateway: ReturnType<typeof createGateway>
beforeAll(() => {
  encGateway = createGateway(encConfig)
  encGateway.listen()
})
afterAll(() => {
  encGateway.httpServer.close()
})

it('param encryption round-trip', async () => {
  // 前端用后端公钥加密请求；网关用后端私钥解密。
  const payload = encryptWithPublicKey(backendKeys.publicKey, JSON.stringify({ deviceId: 'd2' }))
  const res = await fetch(`http://127.0.0.1:${encConfig.port}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
  expect(res.status).toBe(201)
  const body = (await res.json()) as { encrypted: boolean; data: string }
  expect(body.encrypted).toBe(true)
  // 网关用前端公钥加密响应；前端用前端私钥解密。
  const decrypted = JSON.parse(decryptWithPrivateKey(frontendKeys.privateKey, body.data)) as { id: number }
  expect(typeof decrypted.id).toBe('number')
})

it('device_data: api-key 落库加密、读取解密；其它类型保持明文', async () => {
  const db = createDb(':memory:')
  const k = generateRsaKeyPair()
  const mapper = deviceDataMapper(db, k.publicKey, k.privateKey)
  const secret = JSON.stringify({ provider: 'openai', apiKey: 'sk-123' })
  await mapper.create('dkey', 'api-key', secret)
  await mapper.create('dkey', 'sensor', '{"temp":26}')

  // 落库原文应为密文，不等于明文
  const raw = await db.select().from(deviceData)
  const apiRow = raw.find((r) => r.type === 'api-key')!
  expect(apiRow.payload).not.toBe(secret)

  // 读取应解密回原文；非 api-key 类型保持明文
  const listed = await mapper.listByDevice('dkey')
  expect(listed.find((r) => r.type === 'api-key')!.payload).toBe(secret)
  expect(listed.find((r) => r.type === 'sensor')!.payload).toBe('{"temp":26}')
})
