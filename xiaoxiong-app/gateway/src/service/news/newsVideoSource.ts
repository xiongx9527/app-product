import { getWbiKey, wbiSign, extractBilibiliAudio } from '../music/baidu/bilibiliAudio'
import type { MusicFetcher } from '../music/types'

/**
 * 新闻播报的音频来源：从视频网站抓「真实新闻视频」并抽取其中的音频轨道，
 * 而不是把文字标题用 TTS 合成——用户明确要求音频必须来自网站、视频的要提取音轨。
 *
 * 复用音乐模块已验证可靠的 B 站链路：
 *  - 搜索接口（WBI 签名）按关键词找新闻视频；
 *  - extractBilibiliAudio 拿 dash 纯音轨直链（m4s，带防盗链由网关 /music/stream 代理）；
 *  - 上层用 adtsKeyFor 生成短链 key、后台 prewarm 转封装 ADTS，走 media.play.audioPath。
 * 全链路与评书/音乐点播一致，真机已验证可靠，无需新建下载/转封装能力。
 *
 * 关键词策略：
 *  - 泛播（keyword=null）搜「今日新闻」，拿当日新闻类视频（如「三分钟了解今日新闻联播」）；
 *  - 带话题（如「科技」）搜「科技 新闻」，score 时话题词命中者优先，但不过度严格——
 *    新闻视频标题千变万化，宁可取一条相关新闻视频，也不要因为标题不含精确词就报「没找到」。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, likes Gecko) Chrome/120.0 Safari/537.36'
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
const BILI_SEARCH = 'https://api.bilibili.com/x/web-interface/wbi/search/all/v2'

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<MusicFetcher>

/**
 * 清洗标题：用户要求「文字一定是助手里显示、播报的，特殊文字/下划线要去掉」。
 * 视频标题常混入下划线、竖线、【】、emoji、markdown 符号等，显示在助手气泡里很脏。
 * 这里只保留中文/英文/数字与常规中文标点，其余空白与符号折叠掉；清洗后仍为空则回退原标题去空白。
 */
export function cleanNewsTitle(raw: string): string {
  if (!raw) return ''
  const stripped = raw
    .replace(/<[^>]*>/g, '') // HTML / <em> 高亮标签
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '') // emoji / 装饰符号
    .replace(/[_~`*#>|｜\[\]{}【】〔〕《》「」『』]/g, ' ') // 下划线、全/半角竖线与常见特殊括号/ markdown 符号
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped || raw.replace(/\s+/g, ' ').trim()
}

export interface NewsVideo {
  /** dash 纯音轨直链（m4s，需经网关代理/转封装，调用方用 adtsKeyFor 生成短链 key） */
  url: string
  /** 视频标题（已清洗，展示 + 供上层判重） */
  title: string
  bvid: string
  cover?: string
}

export interface NewsVideoOptions {
  /** 注入 fetcher 便于测试；缺省用全局 fetch。 */
  fetcher?: MusicFetcher
  /** 覆盖搜索关键词（测试可注入固定词，避免依赖真实搜索结果）。 */
  searchKeyword?: (keyword: string | null) => string
}

/** 搜索候选（列表阶段）：只有标题/BVID，尚未抽音轨。标题已清洗。 */
export interface NewsVideoCandidate {
  bvid: string
  title: string
  cover?: string
}

/** 递归收集搜索结果里所有「同时带 bvid 与 title」的视频条目（去重保序，标题已清洗）。 */
function collectHits(node: unknown, out: Map<string, NewsVideoCandidate> = new Map()): NewsVideoCandidate[] {
  if (!node || typeof node !== 'object') return [...out.values()]
  if (Array.isArray(node)) {
    for (const item of node) collectHits(item, out)
    return [...out.values()]
  }
  const obj = node as Record<string, unknown>
  if (typeof obj.bvid === 'string' && typeof obj.title === 'string') {
    if (!out.has(obj.bvid)) {
      out.set(obj.bvid, {
        bvid: obj.bvid,
        title: cleanNewsTitle(String(obj.title)),
        ...(typeof obj.pic === 'string' ? { cover: obj.pic } : {}),
      })
    }
  }
  for (const key of Object.keys(obj)) collectHits(obj[key], out)
  return [...out.values()]
}

/** 明显不是「新闻播报」的视频类型词：命中则降权/排除（混剪/解说/影视等）。 */
const AVOID = /混剪|剪辑|鬼畜|搞笑|段子|影视解说|电影解说|短剧|游戏|直播回放|UP主|react|reaction/i
/** 强新闻特征词：命中优先（新闻联播/今日新闻/早报/晚报/快讯/播报等）。 */
const PREFER = /新闻联播|今日新闻|新闻早|新闻晚|早报|晚报|新闻|快讯|播报|要闻|头条/i

function scoreHit(hit: NewsVideoCandidate, keyword: string | null): number {
  let score = 0
  if (PREFER.test(hit.title)) score += 10
  if (AVOID.test(hit.title)) score -= 20
  if (keyword && hit.title.includes(keyword)) score += 6
  // 明显的「三分钟了解今日新闻联播」这类短资讯最合适；超长合集/整期回放降权
  if (/合集|全程|完整版|一小时|3小时|24小时/.test(hit.title)) score -= 4
  return score
}

export function createNewsVideoSource(options: NewsVideoOptions = {}) {
  const fetcher = options.fetcher ?? nativeFetch
  const keywordFor =
    options.searchKeyword ??
    ((keyword: string | null) => (keyword ? `${keyword} 新闻` : '今日新闻'))

  /** 搜索候选视频（不抽取音轨），上层据此列给用户选。 */
  async function search(keyword: string | null): Promise<NewsVideoCandidate[]> {
    const kw = keywordFor(keyword)
    const key = await getWbiKey(fetcher)
    const wts = String(Math.floor(Date.now() / 1000))
    const wrid = wbiSign({ keyword: kw, wts }, key)
    const qs = new URLSearchParams({ keyword: kw, wts, w_rid: wrid }).toString()
    const resp = await fetcher(`${BILI_SEARCH}?${qs}`, { headers: HEADERS })
    const json = (await resp.json()) as unknown
    const hits = collectHits(json)
    return hits.sort((a, b) => scoreHit(b, keyword) - scoreHit(a, keyword))
  }

  /** 按 BVID 抽取该视频的 dash 音轨直链；失败返回 null。用户选中某条候选时才调用。 */
  async function resolveBvid(candidate: NewsVideoCandidate): Promise<NewsVideo | null> {
    try {
      const audio = await extractBilibiliAudio(candidate.bvid, fetcher)
      if (!audio?.url) return null
      return {
        url: audio.url,
        title: cleanNewsTitle(audio.title || candidate.title) || candidate.title,
        bvid: candidate.bvid,
        ...(candidate.cover ? { cover: candidate.cover } : {}),
      }
    } catch {
      return null
    }
  }

  return { name: 'bilibili-news-video', searchKeyword: keywordFor, search, resolveBvid }
}

/** createNewsVideoSource 返回的实例形状，供 voiceSessionService 声明依赖/字段。 */
export type NewsVideoSourceLike = ReturnType<typeof createNewsVideoSource>
