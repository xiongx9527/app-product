/**
 * 外部音频本地短链缓存：解决「DCloud AudioPlayer 直拉第三方 HTTP 流不稳（-99、不发请求）」。
 *
 * 音乐/新闻音轨走 musicStreamController 的 ADTS 短链（有 LRU=2 会清理），
 * 百科/诗词的第三方 TTS mp3 不能塞进去（会被音乐播放挤掉），故用独立目录 + 独立短链。
 *
 * 流程：网关下发 media.play 前，先把外部 mp3 下载落盘 → 下发短链 /media/s/<key>.mp3
 *      → 客户端下载 <httpBase>/media/s/<key>.mp3 本地播（稳定）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { createReadStream, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mp3DurationSec } from './mp3Duration'

const CACHE_MAX = 12 // 最多留 12 个音频文件（百科/诗词量小），LRU 清理

let cacheDir: string | null = null
function getCacheDir(): string {
  if (cacheDir) return cacheDir
  const home = process.env.GATEWAY_HOME ?? process.cwd()
  cacheDir = `${home}/cache/media`
  try { if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true }) } catch { /* 响应时再报错 */ }
  return cacheDir
}

function keyFor(url: string): string {
  return createHash('md5').update(url).digest('hex').slice(0, 16)
}

function pathForKey(key: string): string | null {
  if (!/^[0-9a-f]{16}$/.test(key)) return null
  const file = `${getCacheDir()}/${key}.mp3`
  return existsSync(file) ? file : null
}

function prune(): void {
  try {
    const dir = getCacheDir()
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.mp3'))
      .map((f) => {
        try { return { f, at: statSync(`${dir}/${f}`).mtimeMs } } catch { return { f, at: 0 } }
      })
      .sort((a, b) => a.at - b.at)
    while (files.length > CACHE_MAX) {
      const oldest = files.shift()
      if (oldest) { try { unlinkSync(`${dir}/${oldest.f}`) } catch { /* 忽略 */ } }
    }
  } catch { /* 清理失败不影响主流程 */ }
}

export interface MediaFetcher {
  (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean
    arrayBuffer: () => Promise<ArrayBuffer>
  }>
}

/**
 * 下载外部音频并落盘，返回本地短链。已缓存则直接返回（同 url 复用）。
 * 下载失败返回 null，由调用方决定是否回退原始 url。
 */
export async function cacheExternalAudio(
  url: string,
  fetcher: MediaFetcher = fetch as unknown as MediaFetcher,
): Promise<string | null> {
  const key = keyFor(url)
  const existing = pathForKey(key)
  if (existing) return `/media/s/${key}.mp3`
  try {
    const resp = await fetcher(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    })
    if (!resp.ok) return null
    const buf = Buffer.from(await resp.arrayBuffer())
    if (!buf.length) return null
    writeFileSync(`${getCacheDir()}/${key}.mp3`, buf)
    prune()
    return `/media/s/${key}.mp3`
  } catch {
    return null
  }
}

/**
 * 从已缓存的短链读音频真实时长（秒）。逐帧解析 mp3 帧头（CBR/VBR 都适用），
 * 不再假设固定码率——诗词音频实测有 320kbps 立体声、~57kbps 立体声等多种规格，
 * 用 bytes/32000 估算会把时长放大数倍，字幕随之越走越慢（2026-11-18 真机）。
 * 解析失败/文件不存在返回 0（调用方回退估算）。
 */
export function getCachedAudioDuration(shortPath: string): number {
  const key = shortPath.match(/([0-9a-f]{16})\.mp3$/)?.[1]
  if (!key) return 0
  const file = pathForKey(key)
  if (!file) return 0
  try {
    return mp3DurationSec(readFileSync(file))
  } catch {
    return 0
  }
}

/** serve GET/HEAD /media/s/<key>.mp3：支持 Range + CORS，content-type audio/mpeg。 */
export function handleMediaByKey(req: IncomingMessage, res: ServerResponse, key: string): void {
  const file = pathForKey(key)
  if (!file) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const size = statSync(file).size
  const range = req.headers.range ? /bytes=(\d+)-(\d*)/.exec(req.headers.range) : null
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'content-type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
  }
  if (range) {
    const start = Math.min(Number(range[1]), Math.max(0, size - 1))
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': String(size) })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  }
}
