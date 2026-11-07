import { createHash } from 'node:crypto'
import type { MusicFetcher } from './types'

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

function wbiSign(params: Record<string, string>, key: string): string {
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

async function getWbiKey(fetcher: MusicFetcher): Promise<string> {
  const resp = await fetcher('https://api.bilibili.com/x/web-interface/nav', { headers: BILI_HEADERS })
  const json = (await resp.json()) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } }
  }
  const img = json.data?.wbi_img?.img_url ?? ''
  const sub = json.data?.wbi_img?.sub_url ?? ''
  const raw =
    (img.split('/').pop()?.split('.')[0] ?? '') + (sub.split('/').pop()?.split('.')[0] ?? '')
  return mixinKey(raw)
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
