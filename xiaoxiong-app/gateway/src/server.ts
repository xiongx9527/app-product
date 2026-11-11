import 'dotenv/config'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { loadConfig } from './config'
import { createDb } from './db/client'
import { createDataService } from './service/dataService'
import { createApiController } from './controller/apiController'
import { createDocsController } from './controller/docsController'
import { handleMusicStream } from './controller/musicStreamController'
import { createVoiceConnection } from './controller/voiceController'
import { buildHealth } from './service/health'
import type { VoiceConfig } from './voiceConfig'
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
  const data = createDataService(db)
  const api = createApiController(data, config)
  const docs = createDocsController()

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    try {
      // 跨域预检（CORS preflight）：浏览器对 DELETE 或带自定义头的请求会先发 OPTIONS。
      // H5 页面（与网关不同端口）调用 /api/* 需要这部分，否则浏览器直接拦截实际请求。
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': req.headers['access-control-request-headers'] ?? 'content-type',
          'content-length': '0',
        })
        res.end()
        return
      }

      // 健康检查：汇总 LLM / ASR / TTS 就绪状态（是否真接入引擎 + 地址是否可达）。
      // 允许跨域，便于 H5（与网关不同端口）直接拉取展示；不做鉴权——仅暴露能力状态，不含密钥。
      // 客户端可经 x-voice-config 头带上当前选中的语音来源配置，使探测按所选来源（如 DashScope）
      // 展开，而非永远探测网关默认的（内置）。响应不含任何密钥。
      if (url.pathname === '/api/health' || url.pathname === '/health') {
        let voice: VoiceConfig | undefined
        const rawVoice = req.headers['x-voice-config']
        if (typeof rawVoice === 'string') {
          try {
            voice = JSON.parse(rawVoice) as VoiceConfig
          } catch {
            voice = undefined
          }
        }
        // deep=1：一键检测走「真正调用模型」的深度探测，能暴露欠费 / 模型名 / 密钥这类
        // 「连通但不可用」的故障；普通轮询不带该参数，只做轻量连通探测。
        const deep = url.searchParams.get('deep') === '1'
        const report = await buildHealth(config, voice, deep)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ ok: true, providers: report }))
        return
      }
      if (url.pathname.startsWith(config.apiBase)) {
        const raw =
          req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE'
            ? await readBody(req)
            : undefined
        const body = parseBody(raw, config)
        const result = await api({ method: req.method ?? 'GET', pathname: url.pathname, query: url.searchParams, body })
        // 公开契约文档（Swagger 的 spec 源）不能加密：浏览器里的 Swagger UI 没有解密能力，
        // 加密后会拿到 {"encrypted":true,...} 而无法解析，页面空白。其余 /api/* 仍按开关加密。
        if (config.paramEncrypt && url.pathname !== '/api/openapi.json') {
          // 响应方向：用前端公钥加密，前端用前端私钥解密。
          const data = encryptWithPublicKey(config.rsaFrontendPublicKey, JSON.stringify(result.body ?? null))
          res.writeHead(result.status, {
            'content-type': 'application/json; charset=utf-8',
            'access-control-allow-origin': '*',
          })
          res.end(JSON.stringify({ encrypted: true, data }))
        } else {
          // 允许跨域，便于 H5（与网关不同端口）直接调用 /api/*。
          writeJson(res, result.status, result.body ?? null, {
            'access-control-allow-origin': '*',
          })
        }
        return
      }
      if (url.pathname === '/doc.html') {
        // 单文件入口：直接返回 /docs 的 index.html（内含 <base href="/docs/">，资源仍走 /docs/）
        const out = await docs('/docs')
        if (out) {
          res.writeHead(out.status, {
            'content-type': out.contentType,
            'cache-control': 'no-store',
          })
          res.end(out.body)
          return
        }
      }
      if (url.pathname === '/docs') {
        // 无结尾斜杠时浏览器会按站点根目录解析 index.html 里的相对资源（./swagger-ui.css →
        // /swagger-ui.css → 404），导致整页无样式。301 到 /docs/ 让相对路径自然落点；
        // 同时 HTML 内仍注入 <base href="/docs/"> 作双保险。
        res.writeHead(301, { location: '/docs/' })
        res.end()
        return
      }
      if (url.pathname.startsWith('/docs/')) {
        const out = await docs(url.pathname)
        if (!out) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        // no-store：Swagger 资源不允许缓存，避免浏览器长期留存旧/损坏的 bundle
        // （曾因一次过度替换把 bundle 改坏，浏览器缓存了坏版本导致页面一直空白）。
        res.writeHead(out.status, {
          'content-type': out.contentType,
          'cache-control': 'no-store',
        })
        res.end(out.body)
        return
      }
      // B 站音轨代理：客户端播放器无法自带 Referer，由网关代拉转发。
      // 路由带 .m4a 后缀，便于部分按扩展名判定格式的播放器识别为音频。
      if (url.pathname === '/music/stream' || url.pathname === '/music/stream.m4a') {
        await handleMusicStream(req, res, url.searchParams)
        return
      }
      // 提示音：网关把「能力不可用」提示（网络 / ASR / TTS / LLM 未就绪）的本地录音
      // 经 HTTP 下发给客户端，客户端从网关拉取播放（打包内文件作兜底）。仅放行白名单里的四个文件，
      // 用 basename 校验 + 禁止 `..` 防目录穿越；允许跨域，便于 H5（与网关不同端口）直接加载。
      if (url.pathname.startsWith('/static/cues/')) {
        await serveCue(res, url.pathname)
        return
      }
      res.writeHead(404)
      res.end('not found')
    } catch (err) {
      writeJson(res, 500, { error: (err as Error).message })
    }
  })

  const wss = new WebSocketServer({ server: httpServer, path: config.ws.path })
  wss.on('connection', (ws, req) => {
    createVoiceConnection(ws, req, { config, data })
  })

  return {
    httpServer,
    config,
    // 内嵌模式只绑回环，不把网关暴露到局域网；桌面/外部模式保持默认（监听所有网卡）。
    listen: () =>
      process.env.GATEWAY_MODE === 'embedded'
        ? httpServer.listen(config.port, '127.0.0.1')
        : httpServer.listen(config.port),
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

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders })
  res.end(JSON.stringify(body))
}

// 桌面版按源码相对位置找提示音；离线包里 bundle 位于 assets，import.meta.url 指向 bundle
// 自身、相对路径会落到错误目录，故内嵌模式由原生层注入 GATEWAY_HOME（解包后的私有目录）。
const CUE_DIR = process.env.GATEWAY_HOME
  ? path.join(process.env.GATEWAY_HOME, 'static', 'cues')
  : fileURLToPath(new URL('../static/cues', import.meta.url))
const ALLOWED_CUES = new Set(['network-down', 'asr-down', 'tts-down', 'llm-down', 'mic-denied'])

/** 仅放行白名单内的提示音文件；校验扩展名 + 禁止 `..`，杜绝目录穿越。 */
async function serveCue(res: ServerResponse, pathname: string): Promise<void> {
  const raw = pathname.slice('/static/cues/'.length).split('?')[0]
  // 只允许 <name>.mp3 且 name 在白名单内；禁止路径分隔与 `..`，杜绝目录穿越。
  if (
    !raw.endsWith('.mp3') ||
    raw.includes('/') ||
    raw.includes('..')
  ) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const name = raw.slice(0, -4)
  if (!ALLOWED_CUES.has(name)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  try {
    const data = await readFile(path.join(CUE_DIR, raw))
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=3600',
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
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

// 入口逻辑统一在 src/embedded/entry.ts（桌面 tsx / 移动端 nodejs-mobile 启动均走它）。
// 本文件只导出 createGateway 等能力，不再含自启动块，避免 bundle 内出现双入口。
