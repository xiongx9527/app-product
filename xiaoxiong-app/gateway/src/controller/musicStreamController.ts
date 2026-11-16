import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { fmp4BufferToAdts } from '../service/music/fmp4ToAdts'

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

/** dash 音轨的 ADTS 转换缓存（url → 完整 ADTS buffer）：LRU 上限 2 首，防 NodeMobile 内存膨胀。 */
const adtsCache = new Map<string, Buffer>()
const ADTS_CACHE_MAX = 2
/** 防并发重复转封装：同一 url 的 in-flight promise 共享 */
const adtsInflight = new Map<string, Promise<Buffer>>()

/**
 * 确保 dash 音轨已转封装进缓存（media.play 下发前预热用）：
 * B站直链每次解析都变（签名/deadline），缓存 key 无法跨次命中——客户端首次请求时若缓存
 * 未热，全量拉取+转封装要 2 秒以上，DCloud AudioPlayer 的 prepare 会超时失败（无声）。
 * 所以网关在「下发 media.play 之前」就后台预热，客户端请求到达时秒回。
 */
export async function ensureAdtsCached(raw: string): Promise<Buffer> {
  const cached = adtsCache.get(raw)
  if (cached) return cached
  const inflight = adtsInflight.get(raw)
  if (inflight) {
    return inflight
  }
  const job = (async (): Promise<Buffer> => {
    const upstreamAll = await fetchValidated(raw, undefined)
    if (!upstreamAll.body) throw new Error('upstream empty body')
    const full = Buffer.from(await upstreamAll.arrayBuffer())
    const adts = fmp4BufferToAdts(full)
    if (adtsCache.size >= ADTS_CACHE_MAX) {
      const oldest = adtsCache.keys().next().value
      if (oldest !== undefined) adtsCache.delete(oldest)
    }
    adtsCache.set(raw, adts)
    return adts
  })()
  adtsInflight.set(raw, job)
  try {
    return await job
  } finally {
    adtsInflight.delete(raw)
  }
}

/**
 * 全量拉取 dash 音轨 → 转 ADTS → 缓存 → 按客户端 Range 在 ADTS buffer 上切片响应。
 * 上游必须全量拉（不带 Range）：转封装需要从 ftyp box 边界开始。
 */
async function serveDashAudioAsAdts(
  req: IncomingMessage,
  res: ServerResponse,
  raw: string
): Promise<void> {
  let adts = adtsCache.get(raw)
  if (!adts) {
    try {
      adts = await ensureAdtsCached(raw)
    } catch (err) {
      res.writeHead(502)
      res.end(`transcode error: ${(err as Error).message}`)
      return
    }
  }
  if (!adts) {
    res.writeHead(502)
    res.end('transcode failed')
    return
  }
  const rangeHeader = req.headers.range
  // 客户端 Range 切片（对完整 ADTS 文件任意段都有效，seek/重播/续传全支持）
  const m = rangeHeader ? /bytes=(\d+)-(\d*)/.exec(rangeHeader) : null
  if (m) {
    const start = Math.min(Number(m[1]), Math.max(0, adts.length - 1))
    const end = m[2] ? Math.min(Number(m[2]), adts.length - 1) : adts.length - 1
    res.writeHead(206, {
      'Access-Control-Allow-Origin': '*',
      'content-type': 'audio/aac',
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${adts.length}`,
      'Accept-Ranges': 'bytes',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(adts.subarray(start, end + 1))
    return
  }
  res.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'content-type': 'audio/aac',
    'content-length': String(adts.length),
    'Accept-Ranges': 'bytes',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(adts)
}
