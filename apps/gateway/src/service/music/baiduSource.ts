import {
  genreToKeyword,
  type MusicFetcher,
  type MusicSource,
  type ResolvedTrack,
} from './types'
import { extractBilibiliAudio, extractBvidFromUrl } from './bilibiliAudio'

/**
 * 百度搜索引擎兜底源（免费、无需登录）：
 * 搜歌时百度结果多为 B 站/好看的“视频”，里面就包含要听的歌。这里搜索百度，
 * 跟随结果跳转拿到真实视频页地址，再抽 B 站音轨返回可播放直链。
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
  const links = [
    ...new Set(
      (html.match(/\/link\?url=[^"'\s]+/g) ?? []).map((l) => `https://www.baidu.com${l}`)
    ),
  ]
  // 跳过前 skip 个（换一首时用），最多再试 5 个
  for (const link of links.slice(skip, skip + 5)) {
    try {
      const r = await fetcher(link, { headers: HEADERS })
      const final = r.url
      if (!final) continue
      const bvid = extractBvidFromUrl(final)
      if (bvid) {
        const audio = await extractBilibiliAudio(bvid, fetcher)
        return { url: audio.url, title: audio.title ?? keyword, channel: 'bilibili' }
      }
    } catch {
      // 该结果抽不到音轨，试下一个
    }
  }
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
