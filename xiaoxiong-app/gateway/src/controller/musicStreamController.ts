import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

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
  // B 站 dash 音轨是 .m4s（fMP4/AAC），上游有时标成 application/octet-stream，有时标成
  // video/mp4（其实是纯音频流）。浏览器 <audio>/InnerAudioContext 对这两种标签都可能拒绝解码
  // （MEDIA_ERR_SRC_NOT_SUPPORTED），必须按扩展名统一标成 audio/mp4 才能稳定播放。
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
