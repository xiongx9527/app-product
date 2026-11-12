import { beforeAll, afterAll, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { createGateway } from './server'
import type { GatewayConfig } from './config'
import { createDb } from './db/client'
import { createDataService } from './service/dataService'

// 用真实 HTTP 服务 + 独立临时库做跨域集成测试（不依赖正在运行的 8787 实例）。
// 浏览器从 H5(:5173) 调网关(:8787) 属于跨域，历史上 /api/* 缺 CORS 头导致记忆加载/删除被拦。
const DB_PATH = join(tmpdir(), `gateway-cors-it-${process.pid}.db`)
const PORT = 8811
const ORIGIN = 'http://localhost:5173'

const config: GatewayConfig = {
  port: PORT,
  apiBase: '/api',
  paramEncrypt: false,
  rsaBackendPrivateKey: '',
  rsaFrontendPublicKey: '',
  timeZone: 'Asia/Shanghai',
  voiceBuiltinUrl: 'http://127.0.0.1:9529',
  voiceDashscopeUrl: 'https://dashscope.aliyuncs.com',
  ws: { path: '/ws' },
  llm: { provider: 'stub', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5', apiKey: '', params: {} },
  asr: { provider: 'stub', baseUrl: 'http://127.0.0.1:9529', apiKey: '', endpointMs: 30, params: {} },
  tts: { provider: 'stub', baseUrl: 'http://127.0.0.1:9529', apiKey: '', params: {} },
  db: { path: DB_PATH },
  memory: { consolidateThreshold: 30, consolidateEvery: 5 },
}

let gateway: ReturnType<typeof createGateway>

beforeAll(async () => {
  // 先用同一份临时库插一条记忆，保证 DELETE 能真正删到（验证跨域删除全链路，而非只看头）。
  const db = createDb(DB_PATH)
  const data = createDataService(db)
  await data.saveMemory('xctest', 'cross-origin', '小熊记住了这件事')
  gateway = createGateway(config)
  gateway.listen()
  await new Promise((r) => setTimeout(r, 300))
})

afterAll(() => {
  gateway.httpServer.close()
  try {
    unlinkSync(DB_PATH)
  } catch {
    /* 已删除或仍在被占用，忽略 */
  }
})

it('OPTIONS 预检：DELETE /api/admin/memories 返回 204 + CORS 头', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/memories?deviceId=xctest`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'DELETE',
      'Access-Control-Request-Headers': 'content-type',
    },
  })
  expect(res.status).toBe(204)
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  expect(res.headers.get('access-control-allow-methods')).toContain('DELETE')
  expect(res.headers.get('access-control-allow-methods')).toContain('OPTIONS')
  // 必须回显浏览器声明的请求头，否则实际请求仍被拦
  expect(res.headers.get('access-control-allow-headers')).toBe('content-type')
})

it('GET /api/admin/memories（带 Origin）返回 200 + CORS 头', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/memories?deviceId=xctest`, {
    headers: { Origin: ORIGIN },
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  const body = (await res.json()) as { items: Array<{ key: string }> }
  expect(body.items.some((m) => m.key === 'cross-origin')).toBe(true)
})

it('DELETE /api/admin/memories（带 Origin）跨域删除成功，返回 CORS 头 + {deleted:1}', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/memories?deviceId=xctest`, {
    method: 'DELETE',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'cross-origin' }),
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  const body = (await res.json()) as { deleted: number }
  expect(body.deleted).toBe(1)

  // 删除后确实没了：跨域读回来为空
  const after = await fetch(`http://127.0.0.1:${PORT}/api/admin/memories?deviceId=xctest`, {
    headers: { Origin: ORIGIN },
  })
  const body2 = (await after.json()) as { items: Array<{ key: string }> }
  expect(body2.items.some((m) => m.key === 'cross-origin')).toBe(false)
})

it('GET /api/health（带 Origin）返回 200 + CORS 头（能力自检允许跨域、不鉴权）', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
    headers: { Origin: ORIGIN },
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  const body = (await res.json()) as { ok: boolean }
  expect(body.ok).toBe(true)
})

it('DELETE 清空全部（key 缺省）跨域也返回 CORS 头', async () => {
  // 再补一条，验证清空路径
  const db = createDb(DB_PATH)
  const data = createDataService(db)
  await data.saveMemory('xctest', 'another', '第二条')
  const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/memories?deviceId=xctest`, {
    method: 'DELETE',
    headers: { Origin: ORIGIN },
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  const body = (await res.json()) as { deleted: number }
  expect(body.deleted).toBe(1)
})
