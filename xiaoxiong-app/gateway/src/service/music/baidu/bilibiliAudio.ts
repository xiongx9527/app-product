import { createHash } from 'node:crypto'
import type { MusicFetcher } from '../types'
import type { SubtitleLine } from '../../../protocol'

/**
 * 从 B 站视频抽取可播放音轨（免费、无需登录）：
 * 先用 wbi 签名拿 view（得到 cid），再签名拿 playurl（dash 音频流），
 * 取码率最高的音频直链。该直链带防盗链（需 Referer），由网关 /music/stream 代理转发。
 * 解析逻辑用注入的 fetcher 单测覆盖；线上可用性属尽力而为。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const BILI_HEADERS = { 'User-Agent': UA, Referer: REFERER }

const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

function mixinKey(raw: string): string {
  let key = ''
  for (const i of MIXIN_TABLE) key += raw[i] ?? ''
  return key.slice(0, 32)
}

export function wbiSign(params: Record<string, string>, key: string): string {
  const sorted = Object.entries(params).sort((a, b) => a[0].localeCompare(b[0]))
  const qs = sorted.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return createHash('md5').update(qs + key).digest('hex')
}

export interface BilibiliAudio {
  /** 音频直链（需带 Referer 才能拉，网关代理时会补） */
  url: string
  /** 视频标题，便于客户端展示 */
  title?: string
}

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, { method: init?.method, headers: init?.headers, body: init?.body }) as unknown as ReturnType<MusicFetcher>

/** WBI 密钥有效期约 1 天；模块级缓存避免每次抽音轨/搜索都多打一次 nav。 */
let cachedWbiKey: { key: string; at: number } | null = null

export async function getWbiKey(fetcher: MusicFetcher): Promise<string> {
  if (cachedWbiKey && Date.now() - cachedWbiKey.at < 12 * 60 * 60 * 1000) {
    return cachedWbiKey.key
  }
  const resp = await fetcher('https://api.bilibili.com/x/web-interface/nav', { headers: BILI_HEADERS })
  const json = (await resp.json()) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } }
  }
  const img = json.data?.wbi_img?.img_url ?? ''
  const sub = json.data?.wbi_img?.sub_url ?? ''
  const raw =
    (img.split('/').pop()?.split('.')[0] ?? '') + (sub.split('/').pop()?.split('.')[0] ?? '')
  const key = mixinKey(raw)
  cachedWbiKey = { key, at: Date.now() }
  return key
}

/** 由 BVID 抽取音频直链。fetcher 缺省走全局 fetch。 */
export async function extractBilibiliAudio(
  bvid: string,
  fetcher: MusicFetcher = nativeFetch
): Promise<BilibiliAudio> {
  const key = await getWbiKey(fetcher)
  const wts = String(Math.floor(Date.now() / 1000))

  const viewUrl =
    `https://api.bilibili.com/x/web-interface/wbi/view?bvid=${bvid}` +
    `&wts=${wts}&w_rid=${wbiSign({ bvid, wts }, key)}`
  const viewResp = await fetcher(viewUrl, { headers: BILI_HEADERS })
  const view = (await viewResp.json()) as { code?: number; message?: string; data?: { cid?: number; title?: string } }
  if (view.code !== 0 || !view.data?.cid) {
    throw new Error(`bilibili view 失败：${view.message ?? '无 cid'}`)
  }
  const cid = String(view.data.cid)

  const wts2 = String(Math.floor(Date.now() / 1000))
  const plUrl =
    `https://api.bilibili.com/x/player/wbi/playurl?bvid=${bvid}&cid=${cid}` +
    `&qn=64&fnval=16&wts=${wts2}&w_rid=${wbiSign({ bvid, cid, qn: '64', fnval: '16', wts: wts2 }, key)}`
  const plResp = await fetcher(plUrl, { headers: BILI_HEADERS })
  const pl = (await plResp.json()) as {
    code?: number
    message?: string
    data?: { dash?: { audio?: Array<{ baseUrl?: string | null; bandwidth?: number }> } }
  }
  if (pl.code !== 0 || !pl.data?.dash?.audio?.length) {
    throw new Error(`bilibili playurl 失败：${pl.message ?? '无音频流'}`)
  }
  const audio = [...pl.data.dash.audio].sort(
    (a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0)
  )[0]
  const url = audio?.baseUrl
  if (!url) throw new Error('bilibili 无可播放音频直链')
  return { url, title: view.data.title }
}

/** 从任意 URL 里抽取 BVID；命中返回 BVID，否则返回 null。 */
export function extractBvidFromUrl(url: string): string | null {
  const m = /bilibili\.com\/video\/(BV[0-9A-Za-z]+)/.exec(url)
  return m?.[1] ?? null
}

/**
 * 从整段 HTML 里批量抽取 BVID（去重、保序）。
 * 百度搜索结果把落地 URL 直接写在 mu="..." 属性里，B 站结果并不都走 /link 跳转，
 * 所以从 SERP 全文直接抓 BVID 比逐条跟随 /link 命中率高得多。
 */
export function extractBvidsFromHtml(html: string): string[] {
  const found = html.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/g) ?? []
  return [...new Set(found.map((m) => m.slice(m.lastIndexOf('/') + 1)))]
}

/**
 * 从 B 站视频取字幕（同源：与音乐同一平台，不跨源）。
 * 优先用视频的 AI 字幕/官方字幕字段（音乐视频的 AI 字幕往往就是字幕），
 * 抽不到再退回普通字幕。保留每行起始时间（秒），用于客户端跟随播放进度高亮；
 * 同时合并连续重复行（B 站 AI 字幕常把同一句重复多遍）。
 * 任意环节失败都返回 null，由上层回退「暂无字幕」。
 */
export async function getBilibiliSubtitle(
  bvid: string,
  fetcher: MusicFetcher = nativeFetch
): Promise<SubtitleLine[] | null> {
  let data: {
    lyric?: string
    subtitle?: { list?: Array<{ lan?: string; lan_doc?: string; subtitle_url?: string }> }
  }
  try {
    const key = await getWbiKey(fetcher)
    const wts = String(Math.floor(Date.now() / 1000))
    const url =
      `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}` +
      `&wts=${wts}&w_rid=${wbiSign({ bvid, wts }, key)}`
    const resp = await fetcher(url, { headers: BILI_HEADERS })
    if (!resp.ok) return null
    const json = (await resp.json()) as { data?: typeof data }
    data = json.data ?? {}
  } catch {
    return null
  }

  // 官方字幕字段（部分音乐视频直接带）：本身是 [mm:ss.xxx] 时间轴文本
  const pinned = (data.lyric ?? '').toString().trim()
  if (pinned) {
    const lines = normalizeSubtitleLines(parseLyricLines(pinned))
    return lines.length ? lines : null
  }

  const list = data.subtitle?.list ?? []
  if (!list.length) return null
  // AI 字幕（lan 含 ai / lan_doc 含 AI）通常是字幕；没有就退第一个字幕
  const sub =
    list.find((s) => (s.lan ?? '').includes('ai') || (s.lan_doc ?? '').includes('AI')) ?? list[0]
  const subUrl = sub?.subtitle_url
  if (!subUrl) return null

  try {
    const full = subUrl.startsWith('//') ? `https:${subUrl}` : subUrl
    const sResp = await fetcher(full, { headers: BILI_HEADERS })
    if (!sResp.ok) return null
    const items = (await sResp.json()) as Array<{ from?: number; content?: string }>
    const lines = items.map(captionItemToLine).filter((l): l is SubtitleLine => l !== null)
    const norm = normalizeSubtitleLines(lines)
    return norm.length ? norm : null
  } catch {
    return null
  }
}

/** 解析 [mm:ss.xxx] 时间轴 → 秒；非法返回 NaN。 */
function parseTimecode(tc: string): number {
  const m = /(\d+):(\d{1,2})(?:\.(\d{1,3}))?/.exec(tc)
  if (!m) return NaN
  const mins = Number(m[1])
  const secs = Number(m[2])
  const frac = m[3] ? Number(`0.${m[3]}`) : 0
  return mins * 60 + secs + frac
}

/** 把官方歌词文本（[mm:ss.xxx] 句子）解析成带时间的字幕行数组。 */
function parseLyricLines(raw: string): SubtitleLine[] {
  const out: SubtitleLine[] = []
  for (const rawLine of raw.split('\n')) {
    const idx = rawLine.indexOf(']')
    if (idx > 0 && rawLine[0] === '[') {
      const time = parseTimecode(rawLine.slice(1, idx))
      const text = rawLine.slice(idx + 1).trim()
      if (Number.isFinite(time) && text) out.push({ time, text })
    } else {
      const text = rawLine.trim()
      if (text) out.push({ time: 0, text })
    }
  }
  return out
}

/** 单条字幕 JSON（AI 字幕/普通字幕）：优先用 from 字段的时间，content 里若带 [mm:ss] 也解析，否则时间记 0。 */
function captionItemToLine(item: { from?: number; content?: string }): SubtitleLine | null {
  const raw = (item.content ?? '').trim()
  if (!raw) return null
  const idx = raw.indexOf(']')
  if (raw[0] === '[' && idx > 0) {
    const tc = parseTimecode(raw.slice(1, idx))
    const text = raw.slice(idx + 1).trim()
    if (!text) return null
    return { time: Number.isFinite(tc) ? tc : (item.from ?? 0), text }
  }
  return { time: typeof item.from === 'number' ? item.from : 0, text: raw }
}

/** 合并连续重复行（B 站 AI 字幕常把同一句重复多遍），保留首条的时间。 */
function normalizeSubtitleLines(lines: SubtitleLine[]): SubtitleLine[] {
  const out: SubtitleLine[] = []
  for (const l of lines) {
    const prev = out[out.length - 1]
    if (!prev || l.text !== prev.text) out.push(l)
  }
  return out
}
