import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import { loadConfig } from './config'
import { createDb } from './db/client'
import { createDataService } from './service/dataService'
import { createApiController } from './controller/apiController'
import { createDocsController } from './controller/docsController'
import { createVoiceConnection } from './controller/voiceController'
import { encryptWithPublicKey, decryptWithPrivateKey } from './crypto'
import type { GatewayConfig } from './config'

export interface Gateway {
  httpServer: ReturnType<typeof createServer>
  config: GatewayConfig
  listen: () => void
}

/**
 * 网关入口：同一端口同时承载
 *  - WebSocket 语音（config.ws.path）
 *  - REST 数据接口（config.apiBase）
 *  - Swagger UI（/docs）与 OpenAPI 文档（/api/openapi.json）
 * 心跳：每 15s ping，45s 内无 pong 视为断开（契约要求）。
 */
export function createGateway(config: GatewayConfig = loadConfig()): Gateway {
  const db = createDb(config.db.path)
  const data = createDataService(db, config.db.publicKey, config.db.privateKey)
  const api = createApiController(data)
  const docs = createDocsController()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    try {
      if (url.pathname.startsWith(config.apiBase)) {
        const raw = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined
        const body = parseBody(raw, config)
        const result = await api({ method: req.method ?? 'GET', pathname: url.pathname, query: url.searchParams, body })
        if (config.paramEncrypt) {
          // 响应方向：用前端公钥加密，前端用前端私钥解密。
          const data = encryptWithPublicKey(config.rsaFrontendPublicKey, JSON.stringify(result.body ?? null))
          res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ encrypted: true, data }))
        } else {
          writeJson(res, result.status, result.body ?? null)
        }
        return
      }
      if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) {
        const out = await docs(url.pathname)
        if (!out) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        res.writeHead(out.status, { 'content-type': out.contentType })
        res.end(out.body)
        return
      }
      res.writeHead(404)
      res.end('not found')
    } catch (err) {
      writeJson(res, 500, { error: (err as Error).message })
    }
  })

  const wss = new WebSocketServer({ server: httpServer, path: config.ws.path })
  wss.on('connection', (ws) => {
    createVoiceConnection(ws, { config, data })
  })

  return {
    httpServer,
    config,
    listen: () => httpServer.listen(config.port),
  }
}

function parseBody(raw: string | undefined, config: GatewayConfig): unknown {
  if (!raw) return undefined
  if (!config.paramEncrypt) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  // 请求方向：用后端私钥解密，前端用后端公钥加密。
  try {
    return JSON.parse(decryptWithPrivateKey(config.rsaBackendPrivateKey, raw))
  } catch {
    return undefined
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1_000_000) req.destroy()
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

// 直接运行时启动网关（tsx src/server.ts）
if (import.meta.url === `file://${process.argv[1]}`) {
  const gateway = createGateway()
  gateway.listen()
  console.log(`[gateway] listening on :${gateway.config.port} (ws ${gateway.config.ws.path}, docs /docs)`)
}
