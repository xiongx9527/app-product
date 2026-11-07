import {
  genreToKeyword,
  type MusicFetcher,
  type MusicSource,
  type ResolvedTrack,
} from './types'
import { extractBilibiliAudio, extractBvidFromUrl, extractBvidsFromHtml } from './bilibiliAudio'

/**
 * 百度搜索引擎兜底源（免费、无需登录）：
 * 搜歌时百度结果多为视频（B 站/好看/央视/芒果等），里面就包含要听的歌。
 * 真实 SERP 把落地 URL 直接写在结果的 mu="..." 属性里，B 站结果未必走 /link 跳转，
 * 因此先从 SERP 全文直接抓 BVID 抽音轨；没有内嵌 BVID 时再逐条跟随 /link 跳转补找。
 * 直链带防盗链，由网关 /music/stream 代理转发给客户端。
 * 解析逻辑用注入的 fetcher 单测覆盖；线上可用性属尽力而为。
 */
const BAIDU_SEARCH = 'https://www.baidu.com/s'
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, { method: init?.method, headers: init?.headers, body: init?.body }) as unknown as ReturnType<MusicFetcher>

/** 从候选 BVID 里挑第一个能抽到音轨的返回；全失败抛错。 */
async function firstPlayable(
  bvids: string[],
  fetcher: MusicFetcher,
  keyword: string
): Promise<ResolvedTrack | null> {
  for (const bvid of bvids) {
    try {
      const audio = await extractBilibiliAudio(bvid, fetcher)
      return { url: audio.url, title: audio.title ?? keyword, channel: 'bilibili' }
    } catch {
      // 该视频抽不到音轨，试下一个
    }
  }
  return null
}

/** 从百度搜索结果里挑第一个能抽到 B 站音轨的视频，返回可播放曲目。 */
export async function searchBaiduForTrack(
  genre: string | undefined,
  fetcher: MusicFetcher,
  skip = 0
): Promise<ResolvedTrack> {
  const keyword = genreToKeyword(genre)
  const q = encodeURIComponent(`${keyword} 视频 在线听`)
  const htmlUrl = `${BAIDU_SEARCH}?ie=utf-8&wd=${q}`
  const resp = await fetcher(htmlUrl, { headers: HEADERS })
  const html = await resp.text()

  // 1) 优先：SERP 全文里直接内嵌的 B 站视频直链（mu= 属性 / 普通 href）
  const inline = extractBvidsFromHtml(html)
  const inlineHit = await firstPlayable(inline.slice(skip, skip + 5), fetcher, keyword)
  if (inlineHit) return inlineHit

  // 2) 兜底：逐条跟随 /link?url= 跳转，从落地 URL 里找 BVID
  const links = [
    ...new Set(
      (html.match(/\/link\?url=[^"'\s]+/g) ?? []).map((l) => `https://www.baidu.com${l}`)
    ),
  ]
  const landed: string[] = []
  for (const link of links.slice(skip, skip + 5)) {
    try {
      const r = await fetcher(link, { headers: HEADERS })
      if (!r.url) continue
      const bvid = extractBvidFromUrl(r.url)
      if (bvid) landed.push(bvid)
    } catch {
      // 该跳转抽不到 BVID，试下一个
    }
  }
  const landedHit = await firstPlayable(landed, fetcher, keyword)
  if (landedHit) return landedHit

  throw new Error(`百度搜索未找到「${keyword}」可播放的视频音轨`)
}

export function createBaiduSource(
  _params: Record<string, string | number | boolean> = {},
  fetcher: MusicFetcher = nativeFetch
): MusicSource {
  let skip = 0
  return {
    async resolve(genre?: string) {
      skip = 0
      return searchBaiduForTrack(genre, fetcher, 0)
    },
    async next(genre?: string) {
      skip += 1
      return searchBaiduForTrack(genre, fetcher, Math.min(skip * 3, 30))
    },
  }
}
