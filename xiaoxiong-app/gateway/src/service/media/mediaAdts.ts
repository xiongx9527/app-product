/**
 * dash 音轨 ADTS 系统能力（service 层，纯逻辑、无 HTTP）：上游地址校验/拉取、
 * fMP4→ADTS 转封装、文件缓存（LRU=2）、短链 key、运行期诊断。
 *
 * 转封装结果落临时文件而非全量驻留 Buffer——NodeMobile 上 11.5MB 拉取 + 14MB ADTS
 * 堆外分配会卡死网关进程。HTTP 路由在 controller/mediaStreamController.ts，只做流式响应。
 */
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import {
  closeSync, createWriteStream, existsSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { fmp4BufferToAdts } from './mediaFmp4ToAdts'

/** 代拉上游时用的请求头（B 站防盗链需 Referer、SomaFM 需浏览器 UA）。由调用方传入，fetchValidated 不硬编码。 */
export const UPSTREAM_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
}

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

/** 逐跳跟随重定向并校验每一跳，避免白名单被 302 绕过。headers 由调用方传入（不硬编码 Referer/UA）。 */
export async function fetchValidated(
  raw: string,
  headers: Readonly<Record<string, string>>,
  range?: string,
): Promise<Response> {
  let current = raw
  for (let hop = 0; hop < 5; hop++) {
    if (!isAllowedUpstreamUrl(current)) throw new Error('upstream host not allowed')
    const h = { ...headers }
    if (range) h['Range'] = range
    const resp = await fetch(current, { headers: h, redirect: 'manual' })
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

const ADTS_FILE_MAX = 2
let adtsDir: string | null = null

/** 运行期诊断（NodeMobile 的 console 不进 logcat，改用 /api/diag 查询），环缓冲最近 20 条。 */
const recentErrors: string[] = []
export function recordStreamDiag(msg: string): void {
  recentErrors.push(`${new Date().toISOString()} ${msg}`)
  if (recentErrors.length > 20) recentErrors.shift()
}
export function getStreamDiagnostics(): string[] {
  return [...recentErrors]
}

function getAdtsDir(): string {
  if (adtsDir) return adtsDir
  // 内嵌模式由原生层注入 GATEWAY_HOME（解包后的私有目录）；桌面模式用进程 cwd
  const home = process.env.GATEWAY_HOME ?? process.cwd()
  adtsDir = `${home}/cache/adts`
  try {
    if (!existsSync(adtsDir)) mkdirSync(adtsDir, { recursive: true })
  } catch {
    // 目录已存在或创建失败（响应时会再报错）
  }
  return adtsDir
}

/** 短链 key：md5(url) 前 16 hex。media.play 只下发短链（/music/s/<key>.aac）——
 * 完整代理 URL 约 1000 字符，DCloud 原生下载器/播放器会截断（实测只发出 936 字节就断），
 * 长 URL 必然失败；短链 ~45 字符，稳定可用。 */
export function adtsKeyFor(raw: string): string {
  return createHash('md5').update(raw).digest('hex').slice(0, 16)
}

function adtsFileFor(raw: string): string {
  return `${getAdtsDir()}/${adtsKeyFor(raw)}.aac`
}

/** 按短链 key 取 ADTS 文件路径（严格校验 16 位 hex，防目录穿越）。 */
export function adtsPathForKey(key: string): string | null {
  if (!/^[0-9a-f]{16}$/.test(key)) return null
  const file = `${getAdtsDir()}/${key}.aac`
  return existsSync(file) ? file : null
}

/** LRU 清理：只留最新的 ADTS_FILE_MAX 个文件。 */
function pruneAdtsFiles(): void {
  try {
    const dir = getAdtsDir()
    const files = readdirSync(dir)
      .map((f) => {
        try {
          return { f, at: statSync(`${dir}/${f}`).mtimeMs }
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
/** 等待某 key 的转封装完成（短链请求到达但预热未完时调用；无任务返回 null）。 */
export function waitForAdts(key: string): Promise<string> | null {
  return inFlight.get(key) ?? null
}

export function ensureAdtsFile(raw: string): Promise<string> {
  const key = adtsKeyFor(raw)
  const existing = inFlight.get(key)
  if (existing) return existing
  const p = buildAdtsFile(raw, 0).finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, p)
  return p
}

/** 同一 url 的转封装进行中任务（key → promise）；短链请求据此等待而不是直接 404。 */
const inFlight = new Map<string, Promise<string>>()

async function buildAdtsFile(raw: string, attempt: number): Promise<string> {
  const file = adtsFileFor(raw)
  if (existsSync(file) && statSync(file).size > 0) return file
  // 中间产物：原始 fMP4 先落盘（可续传），再从文件流式转封装（内存 O(box)）。
  const fmp4 = `${file}.fmp4`
  try {
    let total = 0
    for (let round = 0; round < 4; round += 1) {
      const have = existsSync(fmp4) ? statSync(fmp4).size : 0
      if (total > 0 && have >= total) break
      // B站 CDN 对「同一直链重复全量 GET」会限流断流（实测每次固定断在 9534444 字节），
      // 续传必须用 Range 从已有字节处继续，重新全量拉只会再次断在同一位置。
      const upstream = await fetchValidated(raw, UPSTREAM_HEADERS, have > 0 ? `bytes=${have}-` : undefined)
      if (!upstream.body) throw new Error('upstream empty body')
      const cl = upstream.headers.get('content-length')
      const cr = upstream.headers.get('content-range')
      const crTotal = cr ? Number(cr.split('/')[1]) : NaN
      if (Number.isFinite(crTotal) && crTotal > 0) total = crTotal
      else if (cl && have === 0) total = Number(cl)
      let got = 0
      await new Promise<void>((resolve, reject) => {
        const src = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
        const dst = createWriteStream(fmp4, { flags: have > 0 ? 'a' : 'w' })
        src.on('data', (c: Buffer) => {
          got += c.byteLength
        })
        src.on('error', reject)
        dst.on('error', reject)
        dst.on('finish', resolve)
        src.pipe(dst)
      })
      const nowHave = existsSync(fmp4) ? statSync(fmp4).size : 0
      recordStreamDiag(`fmp4 pull round=${round} have=${have} got=${got} now=${nowHave} total=${total}`)
      if (nowHave <= have) break // 上游没有给出更多数据，避免死循环
    }
    if (!existsSync(fmp4) || statSync(fmp4).size <= 0) throw new Error('fmp4 empty after pull')
    // 同步全量转封装（fmp4BufferToAdts 已在 Mac 用真实数据验证）：设备上流式 Transform
    // 从文件读时输出恒为 0（NodeMobile 下 Readable/Transform 行为差异），改用一次性转换。
    // 内存峰值约 in(9.5MB)+out(11MB)，NodeMobile 可承受（此前 26MB 双持才是压力边界）。
    const head = Buffer.alloc(16)
    try {
      const fd = openSync(fmp4, 'r')
      const n = readSync(fd, head, 0, 16, 0)
      closeSync(fd)
      recordStreamDiag('fmp4 head=' + head.subarray(0, n).toString('hex'))
    } catch {
      recordStreamDiag('fmp4 head read failed')
    }
    const full = readFileSync(fmp4)
    const adtsBuf = fmp4BufferToAdts(full)
    writeFileSync(file, adtsBuf)
    recordStreamDiag(`transcoded sync in=${full.length} out=${adtsBuf.length}`)
    try {
      unlinkSync(fmp4)
    } catch {
      // 清理失败无碍
    }
    pruneAdtsFiles()
    const size = existsSync(file) ? statSync(file).size : 0
    if (size <= 0) throw new Error(`transcode produced empty file: ${file}`)
    return file
  } catch (err) {
    recordStreamDiag(`ensureAdtsFile fail(attempt ${attempt}): ${(err as Error).message}`)
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch {
      // 清理失败不影响重试（会覆盖写）
    }
    if (attempt < 1) return buildAdtsFile(raw, attempt + 1)
    throw err
  }
}

/**
 * dash 音轨响应：全量拉取 → 流式转封装 ADTS 临时文件 → 按客户端 Range 从文件切片响应。
 * 上游必须全量拉（不带 Range）：转封装需要从 ftyp box 边界开始。
 */
