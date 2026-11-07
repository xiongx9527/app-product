import {
  genreToKeyword,
  type MusicFetcher,
  type MusicSource,
  type ResolvedTrack,
} from './types'
import { extractBilibiliAudio, extractBvidsFromHtml, getWbiKey, wbiSign } from './bilibiliAudio'

/**
 * 百度搜索兜底：B 站原生搜索对部分歌曲（生僻歌名/特殊字符/新歌）召回不足，
 * 用百度 web 搜索扩大覆盖面。注意百度对服务端请求会频繁弹反爬验证页、且时好时坏，
 * 所以这里百度**只负责找 B 站视频页的 BVID**，真正的音轨仍从 B 站抽（稳定、带防盗链由网关代理），
 * 且抽到的标题一律再过一遍 titleMatchesKeyword 严格校验——绝不因为走了百度就放松匹配，
 * 否则又会回到「播放的不是我要的歌曲」。百度搜不到（验证页/无 B 站链接）就安静回退，
 * 由上层统一告知「没找到」，绝不退回随机电台。
 */
const BAIDU_SEARCH = 'https://www.baidu.com/s'
const BAIDU_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}
/** 百度很可能弹验证页或限流，别让它卡住整轮播放。 */
const BAIDU_TIMEOUT_MS = 6000

/**
 * B 站点歌兜底源（免费、无需登录）：
 * 用 B 站自带的搜索接口（WBI 签名）按「歌手 歌名」检索视频，再抽取音轨直链。
 * 之所以不抓百度直接放歌：百度对服务端请求会频繁弹反爬验证页（1438 字节的「验证」页），
 * 时好时坏，作为点歌兜底不可靠；B 站搜索返回结构化 bvid+标题，稳定可用。
 * 但 B 站原生搜索对部分歌曲召回不足，故新增「百度搜索兜底」：B 站搜不到时改用百度 web 搜索
 * 找回 B 站视频页的 BVID（只找 B 站链接、不做播放），再走 B 站抽音轨，且标题仍过严格匹配，
 * 既扩大覆盖又不放松「歌手、歌名要一样」的约束，杜绝乱播放。
 * 直链带防盗链，由网关 /music/stream 代理转发给客户端。
 * 解析逻辑用注入的 fetcher 单测覆盖；线上可用性属尽力而为。
 */
const BILI_SEARCH = 'https://api.bilibili.com/x/web-interface/wbi/search/all/v2'
const BILI_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
}

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<MusicFetcher>

/** 相关性加分词：更像「原唱/官方正片」的视频优先。 */
const PREFER = ['官方', 'official', 'mv', 'hd', '无损', '原唱', '完整版', '音频', 'opus']
/**
 * 相关性减分词：教学/翻唱/Reaction/纯音乐/现场等不是用户要的那一版，尽量靠后。
 * 注意「现场版」不放这里——它含「现场」子串，会和下面的「现场」一同命中，
 * 一加一减互相抵消反而没起到排序作用；现场版整体仍略逊于录音室原版，故不加分。
 */
const AVOID = [
  '鼓谱', '吉他谱', '钢琴谱', '教学', '教程', '翻唱', 'cover', 'covers',
  'reaction', '反应', '纯音乐', '卡点', '舞蹈', '编舞', '动态', '赏析',
  '解说', '盘点', '混剪', '二创', 'remix', '伴奏', '现场',
]
/**
 * 多歌曲合集类标题：串烧/歌单/合辑等根本不是用户点的那一首，宁可报「没找到」
 * 也不能播——这是「播放的不是我要的歌曲」最典型的来源。与上面的 AVOID 不同，
 * 这里是**硬排除**（直接视为不匹配），而不是靠排序靠后，避免它作为唯一/最高相关结果被播出来。
 */
const COMPILATION_WORDS = ['串烧', '合集', '歌单', '合辑', '集锦', '盘点', '歌曲大全', '音乐大全', '串烧版']

/** 标题是否明显是多歌曲合集（不是单一曲目），应被排除，杜绝乱播放。 */
export function looksLikeCompilation(title: string): boolean {
  if (!title) return false
  const t = normalize(title)
  return COMPILATION_WORDS.some((w) => t.includes(normalize(w)))
}

/** 归一化：去空白、标点、书名号等，统一小写，便于子串比对。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 关键词里的核心实词（长度≥2，剔除口语填充）。「周杰伦 稻香」→ ['周杰伦','稻香']。
 * 用于校验搜索结果视频标题到底是不是用户点的那首。
 */
const KEYWORD_STOPWORDS = new Set([
  '一首', '来首', '放首', '点首', '听首', '这首', '谁都', '没听', '没听过',
  '稀奇', '古怪', '稀奇古怪', '随便', '什么', '哪些', '一些', '一点',
  '歌曲', '音乐', '播放', '来点', '放点', '听点', '在线', '视频',
])

function keywordTokens(keyword: string): string[] {
  return keyword
    .split(/[\s,，、]+/)
    .map((t) => normalize(t))
    .filter((t) => t.length >= 2 && !KEYWORD_STOPWORDS.has(t))
}

/**
 * 视频标题是否就是用户点的歌：关键词里的核心实词（歌手、歌名）要**全部**出现在标题里。
 * 「歌手、歌名要一样」——只沾一个词、或搜索对编造歌名返回的低相关度视频，一律不算命中，
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

/** 视频标题的相关性打分：更像正片加分，教学/翻唱等减分，用于「换一首」挑更对的那版。 */
function relevanceScore(title: string): number {
  const t = normalize(title)
  let s = 0
  for (const w of PREFER) if (t.includes(normalize(w))) s += 1
  for (const w of AVOID) if (t.includes(normalize(w))) s -= 2
  return s
}

interface BiliResult {
  bvid: string
  title: string
}

/** 递归遍历搜索返回的 JSON，收集所有「同时带 bvid 与 title」的视频条目（去重）。 */
function collectResults(node: unknown, out: Map<string, BiliResult> = new Map()): BiliResult[] {
  if (!node || typeof node !== 'object') return [...out.values()]
  if (Array.isArray(node)) {
    for (const item of node) collectResults(item, out)
    return [...out.values()]
  }
  const obj = node as Record<string, unknown>
  if (typeof obj.bvid === 'string' && typeof obj.title === 'string') {
    const bvid = obj.bvid
    if (!out.has(bvid)) {
      out.set(
        bvid,
        // 标题里常混 <em> 高亮标签，去掉再比较
        { bvid, title: String(obj.title).replace(/<[^>]+>/g, '') }
      )
    }
  }
  for (const key of Object.keys(obj)) collectResults(obj[key], out)
  return [...out.values()]
}

/** 一次搜索：WBI 签名后拉结果，过滤+排序，返回按相关性排好的候选视频列表。 */
async function searchOrdered(keyword: string, fetcher: MusicFetcher): Promise<BiliResult[]> {
  const key = await getWbiKey(fetcher)
  const wts = String(Math.floor(Date.now() / 1000))
  const wrid = wbiSign({ keyword, wts }, key)
  const qs = new URLSearchParams({ keyword, wts, w_rid: wrid }).toString()
  const resp = await fetcher(`${BILI_SEARCH}?${qs}`, { headers: BILI_HEADERS })
  const json = (await resp.json()) as unknown
  const results = collectResults(json)
  // 先按「歌手歌名全命中」过滤（杜绝乱播放），再排除多歌曲合集（串烧/歌单…），
  // 最后按相关性打分降序、同分保留 B 站原序
  return results
    .filter((r) => titleMatchesKeyword(r.title, keyword) && !looksLikeCompilation(r.title))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => relevanceScore(b.r.title) - relevanceScore(a.r.title) || a.i - b.i)
    .map((x) => x.r)
}

export function createBilibiliSearchSource(
  _params: Record<string, string | number | boolean> = {},
  fetcher: MusicFetcher = nativeFetch
): MusicSource {
  let lastKeyword = ''
  let ranked: BiliResult[] = []
  let cursor = -1

  /** 从候选里顺序抽下一首可播放的音轨；抽不到（版权/失效）自动试下一个。 */
  async function pickNext(keyword: string): Promise<ResolvedTrack> {
    while (cursor + 1 < ranked.length) {
      cursor += 1
      const r = ranked[cursor]
      try {
        const audio = await extractBilibiliAudio(r.bvid, fetcher)
        if (audio.url) {
          return { url: audio.url, title: audio.title ?? r.title, channel: 'bilibili' }
        }
      } catch {
        // 该视频抽不到音轨，试下一个
      }
    }
    throw new Error(`B 站未找到「${keyword}」可播放的音轨`)
  }

  /** 百度 web 搜索拿到 B 站视频页的 BVID 列表；失败（验证页/限流/无链接）返回空。 */
  async function searchBaiduBvids(keyword: string): Promise<string[]> {
    try {
      const q = encodeURIComponent(`${keyword} bilibili`)
      const resp = await fetcher(`${BAIDU_SEARCH}?wd=${q}`, {
        headers: BAIDU_HEADERS,
        // AbortSignal.timeout 在较旧 Node 可能未实现，用 try 包住避免报错
        ...(typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
          ? { signal: AbortSignal.timeout(BAIDU_TIMEOUT_MS) }
          : {}),
      })
      if (!resp.ok) return []
      const html = await resp.text()
      // 验证页/无结果页里没有 bilibili 直链，extractBvidsFromHtml 自然返回空
      return extractBvidsFromHtml(html)
    } catch {
      return []
    }
  }

  /**
   * 百度兜底：拿 BVID 后逐个抽 B 站音轨，标题必须再过严格匹配，
   * 命中才返回；全失败/百度无果抛错，交上层统一告知「没找到」。
   */
  async function baiduResolve(keyword: string): Promise<ResolvedTrack> {
    const bvids = await searchBaiduBvids(keyword)
    for (const bvid of bvids) {
      try {
        const audio = await extractBilibiliAudio(bvid, fetcher)
        // 关键：百度找回来的视频也得通过「歌手、歌名要一样」校验，且不能是合集，杜绝乱播
        if (
          audio.url &&
          audio.title &&
          titleMatchesKeyword(audio.title, keyword) &&
          !looksLikeCompilation(audio.title)
        ) {
          return { url: audio.url, title: audio.title, channel: 'bilibili' }
        }
      } catch {
        // 该视频抽不到音轨，试下一个
      }
    }
    throw new Error(`B 站/百度均未找到「${keyword}」可播放的音轨`)
  }

  async function doResolve(genre?: string): Promise<ResolvedTrack> {
    const keyword = genreToKeyword(genre)
    lastKeyword = keyword
    // 先清空上一批候选：一旦本轮回填失败，ranked 保持空，保证 next 同关键词会重新检索而非误用旧候选
    ranked = []
    cursor = -1
    try {
      ranked = await searchOrdered(keyword, fetcher)
      return await pickNext(keyword)
    } catch {
      // B 站原生搜索无可用音轨（召回不足/抽不到/网络抖动）→ 再用百度兜底
      return baiduResolve(keyword)
    }
  }

  async function doNext(genre?: string): Promise<ResolvedTrack> {
    const keyword = genre ? genreToKeyword(genre) : lastKeyword
    // 换了歌、或没有候选：重新搜索（含百度兜底）；当前这批全抽不到也回退重新搜索
    if (keyword !== lastKeyword || ranked.length === 0) return doResolve(genre)
    try {
      return await pickNext(keyword)
    } catch {
      return doResolve(genre)
    }
  }

  return { resolve: doResolve, next: doNext }
}
