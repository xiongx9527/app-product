import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { secureRequest } from './secureRequest'
import { encryptWithPublicKey as feEncrypt } from '@/core/crypto/secureParams'

const frontend = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const backend = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const mockRequest = vi.fn()
;(globalThis as unknown as { uni: { request: typeof mockRequest } }).uni = { request: mockRequest }

afterEach(() => {
  vi.unstubAllEnvs()
  mockRequest.mockReset()
})

describe('secureRequest（REST 加解密封装）', () => {
  it('开启加密：POST 请求体被加密为信封、加密响应被解密还原', async () => {
    vi.stubEnv('VITE_PARAM_ENCRYPT', 'true')
    vi.stubEnv('VITE_RSA_FRONTEND_PRIVATE_KEY', frontend.privateKey)
    vi.stubEnv('VITE_RSA_BACKEND_PUBLIC_KEY', backend.publicKey)

    // 网关会加密响应（用前端公钥），这里用同样格式模拟
    const respEnvelope = await feEncrypt(frontend.publicKey, JSON.stringify({ ok: true, id: 9 }))
    mockRequest.mockImplementation((opts: { data?: unknown; success: (r: unknown) => void }) => {
      // 请求体必须是信封字符串
      const env = JSON.parse(String(opts.data))
      expect(env).toHaveProperty('k')
      expect(env).toHaveProperty('iv')
      expect(env).toHaveProperty('t')
      expect(env).toHaveProperty('d')
      opts.success({ statusCode: 200, data: { encrypted: true, data: respEnvelope }, header: {} })
    })

    const res = await secureRequest({
      url: 'http://localhost:8787/api/sessions',
      method: 'POST',
      data: { deviceId: 'd1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.data).toEqual({ ok: true, id: 9 })
  })

  it('开启加密时 GET 不加密请求体（无 body），但解密响应', async () => {
    vi.stubEnv('VITE_PARAM_ENCRYPT', 'true')
    vi.stubEnv('VITE_RSA_FRONTEND_PRIVATE_KEY', frontend.privateKey)
    vi.stubEnv('VITE_RSA_BACKEND_PUBLIC_KEY', backend.publicKey)

    const respEnvelope = await feEncrypt(frontend.publicKey, JSON.stringify([{ id: 1 }]))
    mockRequest.mockImplementation((opts: { data?: unknown; success: (r: unknown) => void }) => {
      // GET 不应有加密信封 body
      expect(opts.data).toBeUndefined()
      opts.success({ statusCode: 200, data: { encrypted: true, data: respEnvelope }, header: {} })
    })

    const res = await secureRequest({ url: 'http://localhost:8787/api/sessions', method: 'GET' })
    expect(res.data).toEqual([{ id: 1 }])
  })

  it('未开启加密：原样透传请求与响应', async () => {
    vi.stubEnv('VITE_PARAM_ENCRYPT', 'false')
    mockRequest.mockImplementation((opts: { data?: unknown; success: (r: unknown) => void }) => {
      expect(opts.data).toEqual({ deviceId: 'd1' })
      opts.success({ statusCode: 201, data: { id: 1 }, header: {} })
    })

    const res = await secureRequest({
      url: 'http://localhost:8787/api/sessions',
      method: 'POST',
      data: { deviceId: 'd1' },
    })
    expect(res.data).toEqual({ id: 1 })
  })
})
