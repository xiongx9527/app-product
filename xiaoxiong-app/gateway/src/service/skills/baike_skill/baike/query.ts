/**
 * 百科查询业务聚合（skill 域内）：取数 + 格式化口播文案 + 真正被播报的正文。
 * skill 直连与 LLM 工具共用这一份，零二次抓取、口径一致，且不依赖 tools 层。
 */
import type { Lang } from '../../../../protocol'
import type { BaikeEntry, BaikeFetcher, BaikeSource } from './types'
import { createDefaultBaikeSource } from './index'

export const MAX_SUMMARY_CHARS = 300

/** 截断摘要到句号边界，避免播一半。 */
export function trimSummary(summary: string, max = MAX_SUMMARY_CHARS): string {
  if (summary.length <= max) return summary
  const head = summary.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'))
  return (cut > max * 0.5 ? head.slice(0, cut + 1) : head).trim()
}

/** 结构化词条 → 本地化口播文案。标题 + 摘要（截断到句号边界）。 */
export function formatBaike(entry: BaikeEntry | null, query: string, lang: Lang | string): string {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  if (!entry || !entry.summary) {
    return prefix === 'en'
      ? `Sorry, I couldn't find information about "${query}".`
      : `暂时没查到「${query}」的百科信息。`
  }
  const body = trimSummary(entry.summary)
  const name = entry.title || query
  return prefix === 'en' ? `${name}. ${body}` : `${name}：${body}`
}

export interface BaikeQueryResult {
  entry: BaikeEntry | null
  text: string
  /** 真正被播报的正文（trimSummary 后），字幕必须用它才与音频同源。 */
  spoken: string
}

/**
 * 一次查询 → 结构化词条 + 口播文案 + 同源正文。
 * source / fetcher 可注入（换源、测试桩）；缺省用默认百度源 + 全局 fetch。
 */
export async function queryBaike(
  query: string,
  lang: Lang | string,
  source: BaikeSource = createDefaultBaikeSource(),
  fetcher: BaikeFetcher = globalThis.fetch as unknown as BaikeFetcher,
): Promise<BaikeQueryResult> {
  let entry: BaikeEntry | null = null
  try {
    entry = await source.fetch(query, fetcher)
  } catch {
    entry = null
  }
  return {
    entry,
    text: formatBaike(entry, query, lang),
    spoken: entry?.summary ? trimSummary(entry.summary) : '',
  }
}
