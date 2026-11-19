import 'dotenv/config'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import { loadConfig } from './config'
import { createDb } from './db/client'
import { createDataService } from './service/dataService'
import { loadAsrCorrections } from './service/voiceSessionService'
import { createCorrectionSyncer } from './service/asrCorrectionSync'
import { createApiController } from './controller/apiController'
import { createDocsController } from './controller/docsController'
import { handleMusicStream, handleAdtsByKey, getMusicDiagnostics } from './controller/musicStreamController'
import { handleMediaByKey } from './service/mediaCache'
import { createVoiceConnection } from './controller/voiceController'
import { loadSkillModules } from './service/skills/loader'
import { buildHealth, clearProbeCache } from './service/health'
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

  // ASR 纠错词表：客户端不做 seed 初始化。词表来自两处——本地 learn_correction 学的，
  // 以及从 9529 增量拉回的审核通过词。启动时先从本地库加载到内存，再启动同步器。
  void data.listFlatAsrCorrections()
    .then((rows) => loadAsrCorrections(rows))
    .catch((e) => console.error('[asr-correction] 加载本地词表失败：', e))
  const correctionSyncer = createCorrectionSyncer(data, config.voiceBuiltinUrl)

  // Skill：按 GATEWAY_HOME/skills.json 配置加载启用的模块（缺省全部），每个会话各自 create 实例。
  const skillModules = loadSkillModules()

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
      // 运行期诊断（只读、本机）：NodeMobile 的 console 不进 logcat，统一从这里查转封装/短链错误。
      // 必须排在 apiBase catch-all 之前，否则会被通用 api 路由抢走。
      if (url.pathname === '/api/diag') {
        writeJson(res, 200, { errors: getMusicDiagnostics() }, { 'access-control-allow-origin': '*' })
        return
      }
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
        // deep=1（一键检测）必须真探：能力探测有 15s 缓存，若链路刚恢复（如 USB 隧道刚连上），
        // 缓存里还是旧的不达结果，会让一键检测一直显示旧的红色。清缓存强制重探。
        if (deep) clearProbeCache()
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
      // dash 音轨短链（/music/s/<16hex>.aac）：media.play 只下发短链，客户端下载后本地播放。
      // 完整代理 URL 约 1000 字符会被 DCloud 原生下载器截断（实测 936 字节即断），必须用短链。
      if (url.pathname.startsWith('/music/s/')) {
        const key = url.pathname.slice('/music/s/'.length).replace(/\.(aac|mp3)$/, '')
        await handleAdtsByKey(req, res, key)
        return
      }
      // 外部音频本地短链（/media/s/<16hex>.mp3）：百科/诗词第三方 TTS mp3 落盘后本地播，
      // 不参与 ADTS 的 LRU 清理。独立短链，避免 DCloud AudioPlayer 直拉第三方 HTTP 流不稳。
      if (url.pathname.startsWith('/media/s/')) {
        const key = url.pathname.slice('/media/s/'.length).replace(/\.mp3$/, '')
        handleMediaByKey(req, res, key)
        return
      }
      // 提示音不再经网关下发：全部走客户端打包内本地文件（唯一一份），断网 / 网关异常都能播。
      // 旧的 /static/cues/* HTTP 通道已移除，客户端 promptPlayer 只从 /static/audio/ 取。
      res.writeHead(404)
      res.end('not found')
    } catch (err) {
      writeJson(res, 500, { error: (err as Error).message })
    }
  })

  const wss = new WebSocketServer({ server: httpServer, path: config.ws.path })
  wss.on('connection', (ws, req) => {
    createVoiceConnection(ws, req, { config, data, correctionSyncer, skillModules })
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
