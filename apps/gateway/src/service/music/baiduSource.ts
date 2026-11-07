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

/**
 * 点歌关键词里的实词（长度≥2，剔除口语填充）。「周杰伦 稻香」→ ['周杰伦','稻香']。
 * 用于校验百度泛搜给的视频到底是不是用户点的那首。
 */
const KEYWORD_STOPWORDS = new Set([
  '一首', '来首', '放首', '点首', '听首', '这首', '谁都', '没听', '没听过',
  '稀奇', '古怪', '稀奇古怪', '随便', '什么', '哪些', '一些', '一点',
  '歌曲', '音乐', '播放', '来点', '放点', '听点', '在线', '视频',
])

/** 归一化：去空白、标点、书名号等，统一小写，便于子串比对。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 关键词里的核心实词；空数组表示无法据此判断相关性。 */
function keywordTokens(keyword: string): string[] {
  return keyword
    .split(/[\s,，、]+/)
    .map((t) => normalize(t))
    .filter((t) => t.length >= 2 && !KEYWORD_STOPWORDS.has(t))
}

/**
 * 视频标题是否就是用户点的歌：关键词里的核心实词（歌手、歌名）要**全部**出现在标题里。
 * 「歌手、歌名要一样」——只沾一个词、或百度对编造歌名返回的低相关度视频，一律不算命中，
 * 避免「说播放周杰伦的稻香却播了别的」。没有可用实词时返回 true
 * （泛化请求已在 genreToKeyword 回落电台，这里不拦）。
 */
export function titleMatchesKeyword(title: string, keyword: string): boolean {
  if (!title) return false
  const tokens = keywordTokens(keyword)
  if (tokens.length === 0) return true
  const normalizedTitle = normalize(title)
  return tokens.every((t) => normalizedTitle.includes(t))
}

/** 从候选 BVID 里挑第一个「能抽到音轨且标题与点歌相关」的返回；全不达标返回 null。 */
async function firstPlayable(
  bvids: string[],
  fetcher: MusicFetcher,
  keyword: string
): Promise<ResolvedTrack | null> {
  for (const bvid of bvids) {
    try {
      const audio = await extractBilibiliAudio(bvid, fetcher)
      // 标题不含歌手/歌名 → 判定为不相干视频，跳过，避免乱播放
      if (!titleMatchesKeyword(audio.title ?? '', keyword)) continue
      return { url: audio.url, title: audio.title ?? keyword, channel: 'bilibili' }
    } catch {
      // 该视频抽不到音轨，试下一个
    }
  }
  return null
}

/** 跟随一页 SERP 里的 /link?url= 跳转，收集落地 URL 里的 BVID。 */
async function landedBvids(html: string, fetcher: MusicFetcher): Promise<string[]> {
  const links = [
    ...new Set(
      (html.match(/\/link\?url=[^"'\s]+/g) ?? []).map((l) => `https://www.baidu.com${l}`)
    ),
  ].slice(0, 5)
  const out: string[] = []
  for (const link of links) {
    try {
      const r = await fetcher(link, { headers: HEADERS })
      if (!r.url) continue
      const bvid = extractBvidFromUrl(r.url)
      if (bvid) out.push(bvid)
    } catch {
      // 该跳转抽不到 BVID，试下一个
    }
  }
  return out
}

/**
 * 在某一页百度结果里找可播放曲目：先试 SERP 内嵌 BVID 直链，再试 /link 落地。
 * page 为结果页序号，换算成百度的 pn 参数（每页 10 条）。
 */
async function findOnPage(
  keyword: string,
  page: number,
  fetcher: MusicFetcher
): Promise<ResolvedTrack | null> {
  const q = encodeURIComponent(`${keyword} 视频 在线听`)
  const htmlUrl = `${BAIDU_SEARCH}?ie=utf-8&wd=${q}&pn=${page * 10}`
  const resp = await fetcher(htmlUrl, { headers: HEADERS })
  const html = await resp.text()

  const inline = extractBvidsFromHtml(html)
  const inlineHit = await firstPlayable(inline, fetcher, keyword)
  if (inlineHit) return inlineHit

  const landed = await landedBvids(html, fetcher)
  const landedHit = await firstPlayable([...new Set(landed)], fetcher, keyword)
  if (landedHit) return landedHit

  return null
}

/**
 * 从百度搜索结果里挑第一个能抽到 B 站音轨的视频。
 * 从 startPage 开始最多翻 2 页（换一首时 startPage 递增，拿到不同结果）。
 */
export async function searchBaiduForTrack(
  genre: string | undefined,
  fetcher: MusicFetcher,
  startPage = 0
): Promise<ResolvedTrack> {
  const keyword = genreToKeyword(genre)
  for (let page = startPage; page < startPage + 2; page++) {
    const hit = await findOnPage(keyword, page, fetcher)
    if (hit) return hit
  }
  throw new Error(`百度搜索未找到「${keyword}」可播放的视频音轨`)
}

export function createBaiduSource(
  _params: Record<string, string | number | boolean> = {},
  fetcher: MusicFetcher = nativeFetch
): MusicSource {
  let page = 0
  return {
    async resolve(genre?: string) {
      page = 0
      return searchBaiduForTrack(genre, fetcher, 0)
    },
    async next(genre?: string) {
      page = Math.min(page + 1, 5)
      return searchBaiduForTrack(genre, fetcher, page)
    },
  }
}
