import type { DataService } from '../service/dataService'
import { openApiSpec } from '../openapi'

export interface ApiRequest {
  method: string
  pathname: string
  query: URLSearchParams
  body: unknown
}

export interface ApiResult {
  status: number
  body?: unknown
}

/**
 * 对外 REST 接口 controller：集中处理所有 /api/* 请求（含 OpenAPI 文档与数据接口），
 * 只负责解析请求、调用 service、组装响应；参数加密在 server 传输层统一处理。
 *
 * 注意：DataService 的各方法都是异步（Drizzle 查询返回 Promise），这里统一 await，
 * 否则会把 pending Promise 直接 JSON 序列化成了 {}。
 */
export function createApiController(data: DataService) {
  return async (req: ApiRequest): Promise<ApiResult> => {
    const { method, pathname, query, body } = req
    const deviceId = query.get('deviceId')

    if (pathname === '/api/health') return { status: 200, body: { ok: true } }
    if (pathname === '/api/openapi.json') return { status: 200, body: openApiSpec }

    if (pathname === '/api/sessions' && method === 'POST') {
      const b = (body ?? {}) as { deviceId?: string; startedAt?: number }
      const id = await data.createSession(b.deviceId ?? deviceId ?? null, b.startedAt ?? Date.now())
      return { status: 201, body: { id } }
    }
    if (pathname === '/api/sessions' && method === 'GET') {
      return { status: 200, body: await data.listSessions(deviceId) }
    }

    if (pathname === '/api/device-data' && method === 'POST') {
      const b = (body ?? {}) as { type?: string; payload?: unknown }
      const id = await data.insertDeviceData(deviceId ?? null, b.type ?? 'unknown', JSON.stringify(b.payload ?? b))
      return { status: 201, body: { id } }
    }
    if (pathname === '/api/device-data' && method === 'GET') {
      return { status: 200, body: await data.listDeviceData(deviceId) }
    }

    if (pathname === '/api/command-logs' && method === 'POST') {
      const b = (body ?? {}) as { command?: string; result?: string }
      const id = await data.insertCommandLog(deviceId ?? null, b.command ?? '', b.result ?? '')
      return { status: 201, body: { id } }
    }
    if (pathname === '/api/command-logs' && method === 'GET') {
      return { status: 200, body: await data.listCommandLogs(deviceId) }
    }

    return { status: 404, body: { error: 'not found' } }
  }
}
