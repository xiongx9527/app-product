/**
 * dash 音轨 HTTP 路由（controller 层，只做请求校验与流式响应）。
 * 所有 ADTS 转封装/缓存/短链/诊断逻辑在 service/media/mediaAdts.ts（系统能力，无 HTTP）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { createReadStream, statSync } from 'node:fs'
import {
  isAllowedUpstreamUrl, inferAudioContentType, fetchValidated, UPSTREAM_HEADERS,
  adtsPathForKey, waitForAdts, ensureAdtsFile, recordStreamDiag,
} from '../service/media/mediaAdts'

/** 处理 GET/HEAD /music/stream?url=...：代理上游音频并流式回传。 */
export async function handleMediaStream(
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
    console.log('[media-stream] m4s', req.method, JSON.stringify(req.headers), 'url.len=', raw.length)
    await serveDashAudioAsAdts(req, res, raw)
    return
  }
  let upstream: Response
  try {
    upstream = await fetchValidated(raw, UPSTREAM_HEADERS, req.headers.range)
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

/** 处理 GET/HEAD /music/s/<key>.aac：按短链 key 返回转封装好的 ADTS 文件（支持 Range）。 */
export async function handleAdtsByKey(
  req: IncomingMessage,
  res: ServerResponse,
  key: string
): Promise<void> {
  let file = adtsPathForKey(key)
  // 预热还没转完时客户端就来取（media.play 不再等预热）：等同一 key 的转封装完成再回，
  // 避免「播放器已出现但短链 404」。等不到就照常 404。
  if (!file) {
    const pending = waitForAdts(key)
    if (pending) {
      recordStreamDiag(`adts-by-key wait key=${key.slice(0, 16)}`)
      try {
        await pending
      } catch {
        // 转封装失败，下面统一 404
      }
      file = adtsPathForKey(key)
    }
  }
  if (!file) {
    recordStreamDiag(`adts-by-key miss key=${key.slice(0, 16)}`)
    res.writeHead(404)
    res.end('not found')
    return
  }
  const size = statSync(file).size
  const rangeHeader = req.headers.range
  const m = rangeHeader ? /bytes=(\d+)-(\d*)/.exec(rangeHeader) : null
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'content-type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
  }
  if (m) {
    const start = Math.min(Number(m[1]), Math.max(0, size - 1))
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    res.writeHead(206, {
      ...headers,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`,
    })
    if (req.method === 'HEAD') return void res.end()
    createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
    return
  }
  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD') return void res.end()
  createReadStream(file).on('error', () => res.destroy()).pipe(res)
}

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
      return statSync(file)
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
