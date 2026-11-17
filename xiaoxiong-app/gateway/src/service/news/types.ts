import type { Lang } from '../../protocol'
import { messages } from '../../i18n'

/** 一条新闻标题；source 抓不到就省略（不编造）。 */
export interface NewsHeadline {
  title: string
  source?: string
}

/**
 * 新闻数据源接口（抽象）。百度新闻频道是当前默认实现，未来换源只需新增一个实现并在组合根注入，
 * 不改 newsTool / voiceSessionService。对齐 deals 的 DealsSource 模式。
 */
export interface NewsSource {
  /** 仅日志标识，不对用户暴露 */
  name: string
  /** 泛播（keyword 为 null）返回当日头条页 URL；带话题返回该话题搜索页 URL */
  headlinesUrl(keyword: string | null): string
  /** 纯函数：从 HTML 解析出标题列表；解析不出返回空数组（由上层诚实兜底，不抛） */
  parse(html: string): NewsHeadline[]
}

/** 可注入的抓取器，测试用桩；shape 对齐 deals 的 DealsFetcher / music 的 MusicFetcher。 */
export type NewsFetcher = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

export interface NewsOptions {
  source: NewsSource
  fetcher?: NewsFetcher
  cacheTtlMs?: number
  /** 最多播报条数，默认 5 */
  limit?: number
}

export interface NewsResult {
  headlines: NewsHeadline[]
  /** 抓取是否成功（HTTP 层）。200 但解析出 0 条算成功但空，由文案层报「没查到」 */
  ok: boolean
}

/** 把抓取结果格式化成可 TTS 播报的本地化文本（纯函数，便于测试）。headline 原文不 i18n。 */
export function formatNews(
  lang: Lang | string,
  r: NewsResult,
  keyword: string | null,
  limit = 5
): string {
  const m = messages(lang).news
  if (!r.ok) return m.unavailable()
  const items = r.headlines.slice(0, limit)
  if (!items.length) return m.none(keyword ?? undefined)
  const lines = [m.intro(items.length, keyword ?? undefined)]
  for (const h of items) {
    lines.push(h.source ? `${h.title}，${h.source}。` : `${h.title}。`)
  }
  return lines.join('')
}
