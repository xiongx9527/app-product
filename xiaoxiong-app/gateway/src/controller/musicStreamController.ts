import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { createFmp4ToAdtsStream } from '../service/music/fmp4ToAdts'

/**
 * B 站音轨直链带防盗链（必须带 Referer），而客户端 InnerAudioContext 无法自定义请求头，
 * 因此由网关 /music/stream 代拉并转发给客户端。SomaFM 的 Icecast 还会拒绝非浏览器 UA，
 * 原生 App 播放器借网关的浏览器 UA 代拉才能播放。
 * 仅放行白名单域名后缀，逐跳校验重定向，避免被当作任意 URL 代理（SSRF）。
 * 与 service/music 里 needsProxy 的 PROXY_HOST_SUFFIXES 需保持同步。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

/**
 * 允许代理的上游 CDN 域名后缀。后缀匹配，子域自动覆盖。
 * B 站音轨只落在这些域（upos-sz-mirrorali.bilivideo.com、xy.mcdn.bilivideo.cn、
 * nqyu06l.edge.mountaintoys.cn 等都能命中；mountaintoys.cn / biliapi.com 是 B 站
 * 新版 mcdn 边缘节点，缺了会让「播放失败」）。somafm.com 是风格电台源，原生 App
 * 播放器 UA 被拒，需网关代拉。
 */
const ALLOWED_HOST_SUFFIXES = [
  'bilivideo.com',
  'bilivideo.cn',
  'akamaized.net',
  'hdslb.com',
  'bilicdn1.com',
  'szbdyd.com',
  'mountaintoys.cn',
  'biliapi.com',
  'somafm.com',
]

/** 上游地址是否安全可代理：http(s) 协议 + host 命中白名单。导出便于单测。 */
export function isAllowedUpstreamUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    const h = u.hostname.toLowerCase()
    return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))
  } catch {
    return false
  }
}

/** 按上游 URL 扩展名推断音频 MIME；B 站 .m4s/.m4a 是无 moov 头的 fMP4/AAC 片段，标 audio/mp4。 */
export function inferAudioContentType(raw: string): string {
  try {
    const path = new URL(raw).pathname.toLowerCase()
    if (path.endsWith('.m4s') || path.endsWith('.m4a') || path.endsWith('.mp4')) return 'audio/mp4'
    if (path.endsWith('.mp3')) return 'audio/mpeg'
    if (path.endsWith('.aac')) return 'audio/aac'
    if (path.endsWith('.ogg')) return 'audio/ogg'
  } catch {
    // 忽略
  }
  return 'audio/mpeg'
}

/** 逐跳跟随重定向并校验每一跳，避免白名单被 302 绕过。 */
async function fetchValidated(raw: string, range?: string): Promise<Response> {
  let current = raw
  for (let hop = 0; hop < 5; hop++) {
    if (!isAllowedUpstreamUrl(current)) throw new Error('upstream host not allowed')
    const headers: Record<string, string> = { 'User-Agent': UA, Referer: REFERER }
    if (range) headers['Range'] = range
    const resp = await fetch(current, { headers, redirect: 'manual' })
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location')
      if (!loc) throw new Error('redirect without location')
      current = new URL(loc, current).toString()
      continue
    }
    return resp
  }
  throw new Error('too many redirects')
}

/** 处理 GET/HEAD /music/stream?url=...：代理上游音频并流式回传。 */
export async function handleMusicStream(
  req: IncomingMessage,
  res: ServerResponse,
  searchParams: URLSearchParams
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    res.end()
    return
  }
  const raw = searchParams.get('url')
  if (!raw || !isAllowedUpstreamUrl(raw)) {
    res.writeHead(400)
    res.end('invalid or disallowed url')
    return
  }
  // B 站 dash 纯音轨（.m4s）是 fragmented MP4：设备 NuPlayer 对 dash brand 嗅探失败
  // （cannot create extractor → 无声），需要转封装成 ADTS 裸 AAC（见 fmp4ToAdts.ts）。
  // 必须走「全量转封装 + 缓存 + 完整响应」模式：流式转封装只支持从头播，播放器 seek/
  // 重播/续传发出的中途 Range 请求会从非 box 边界开始，转出来的流是坏的（时好时坏的根源）。
  // 全量转完是标准 ADTS 文件（带 content-length），对任意 Range 在 ADTS buffer 上切片即可。
  // 分流必须在首次上游拉取之前：转封装内部自行全量拉取，不吃客户端的 Range。
  if (inferAudioContentType(raw) === 'audio/mp4' && raw.includes('.m4s')) {
    // 临时诊断：记录客户端请求头（nodejs-mobile console 进 logcat），定位 DCloud AudioPlayer 的请求形态
    console.log('[music-stream] m4s', req.method, JSON.stringify(req.headers), 'url.len=', raw.length)
    await serveDashAudioAsAdts(req, res, raw)
    return
  }
  let upstream: Response
  try {
    upstream = await fetchValidated(raw, req.headers.range)
  } catch (err) {
    res.writeHead(502)
    res.end(`upstream error: ${(err as Error).message}`)
    return
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
  }
  for (const key of ['content-type', 'content-length', 'content-range', 'cache-control', 'etag']) {
    const v = upstream.headers.get(key)
    if (v) headers[key] = v
  }
  const ct = headers['content-type']
  if (!ct || ct === 'application/octet-stream' || ct === 'video/mp4') {
    headers['content-type'] = inferAudioContentType(raw)
  }
  res.writeHead(upstream.status, headers)

  if (req.method === 'HEAD' || !upstream.body) {
    res.end()
    return
  }
  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/**
 * dash 音轨的 ADTS 文件缓存：转封装结果写临时文件（内存 O(单个 box)，绝不全量占 Buffer——
 * NodeMobile 上 11.5MB 拉取 + 14MB ADTS 的堆外分配会把 :gateway 的 Node 卡死，表现为
 * 网关进程活着但 8787 不响应、App 反复重启 GatewayNodeService）。LRU 上限 2 个文件。
 */
const ADTS_FILE_MAX = 2
let adtsDir: string | null = null

function getAdtsDir(): string {
  if (adtsDir) return adtsDir
  // 内嵌模式由原生层注入 GATEWAY_HOME（解包后的私有目录）；桌面模式用进程 cwd
  const home = process.env.GATEWAY_HOME ?? process.cwd()
  adtsDir = `${home}/cache/adts`
  try {
    if (!existsSync(adtsDir)) {
      // mkdirSync 顶层导入太重，惰性 require 避免 bundle 顶层体积
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('node:fs') as typeof import('node:fs')
      fs.mkdirSync(adtsDir, { recursive: true })
    }
  } catch {
    // 目录已存在或创建失败（响应时会再报错）
  }
  return adtsDir
}

function adtsFileFor(raw: string): string {
  const hash = createHash('md5').update(raw).digest('hex').slice(0, 16)
  return `${getAdtsDir()}/${hash}.aac`
}

/** LRU 清理：只留最新的 ADTS_FILE_MAX 个文件。 */
function pruneAdtsFiles(): void {
  try {
    const dir = getAdtsDir()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs')
    const files = readdirSync(dir)
      .map((f) => {
        try {
          return { f, at: fs.statSync(`${dir}/${f}`).mtimeMs }
        } catch {
          return { f, at: 0 }
        }
      })
      .sort((a, b) => a.at - b.at)
    while (files.length > ADTS_FILE_MAX) {
      const oldest = files.shift()
      if (oldest) {
        try {
          unlinkSync(`${dir}/${oldest.f}`)
        } catch {
          // 已被清理，忽略
        }
      }
    }
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * 确保 dash 音轨已转封装成 ADTS 临时文件（media.play 下发前预热用）：
 * B站直链每次解析都变（签名/deadline），缓存 key 无法跨次命中——客户端首次请求时若缓存
 * 未热，全量拉取+转封装要 2 秒以上，DCloud AudioPlayer 的 prepare 会超时失败（无声）。
 * 所以网关在「下发 media.play 之前」就后台预热，客户端请求到达时秒回。
 * 返回 ADTS 文件路径；同一个 url 的 in-flight promise 共享，防并发重复转封装。
 */
export async function ensureAdtsFile(raw: string): Promise<string> {
  const file = adtsFileFor(raw)
  if (existsSync(file)) return file
  const upstreamAll = await fetchValidated(raw, undefined)
  if (!upstreamAll.body) throw new Error('upstream empty body')
  await new Promise<void>((resolve, reject) => {
    const src = Readable.fromWeb(upstreamAll.body as Parameters<typeof Readable.fromWeb>[0])
    const dst = createWriteStream(file)
    const adts = createFmp4ToAdtsStream()
    src.on('error', reject)
    dst.on('error', reject)
    adts.on('error', reject)
    dst.on('finish', () => resolve())
    // 关键：必须经转封装 Transform 再落盘——直接 pipe 会把 fMP4 原样存成文件，
    // 客户端播本地 fMP4 同样 cannot create extractor（无声）。
    src.pipe(adts).pipe(dst)
  })
  pruneAdtsFiles()
  return file
}

/**
 * dash 音轨响应：全量拉取 → 流式转封装 ADTS 临时文件 → 按客户端 Range 从文件切片响应。
 * 上游必须全量拉（不带 Range）：转封装需要从 ftyp box 边界开始。
 */
async function serveDashAudioAsAdts(
  req: IncomingMessage,
  res: ServerResponse,
  raw: string
): Promise<void> {
  let file: string
  try {
    file = await ensureAdtsFile(raw)
  } catch (err) {
    res.writeHead(502)
    res.end(`transcode error: ${(err as Error).message}`)
    return
  }
  const stat = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('node:fs') as typeof import('node:fs')
      return fs.statSync(file)
    } catch {
      return null
    }
  })()
  if (!stat || stat.size === 0) {
    res.writeHead(502)
    res.end('transcode empty')
    return
  }
  const rangeHeader = req.headers.range
  // 客户端 Range 切片（对完整 ADTS 文件任意段都有效，seek/重播/续传全支持）
  const m = rangeHeader ? /bytes=(\d+)-(\d*)/.exec(rangeHeader) : null
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'content-type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
  }
  if (m) {
    const start = Math.min(Number(m[1]), Math.max(0, stat.size - 1))
    const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1
    res.writeHead(206, {
      ...headers,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${stat.size}`,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file, { start, end })
      .on('error', () => res.destroy())
      .pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(stat.size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
}
