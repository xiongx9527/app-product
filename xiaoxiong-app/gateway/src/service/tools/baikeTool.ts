import { z } from 'zod'
import type { Lang } from '../../protocol'
import {
  createDefaultBaikeSource,
  type BaikeEntry,
  type BaikeFetcher,
  type BaikeSource,
} from '../baike'

/** 工具名固定，作为 LLM 函数调用标识，不要本地化。 */
export const BAIKE_TOOL_NAME = 'query_baike'

/** 单个词条摘要最多播报多少字（百科摘要可达数百字，全念太长）。 */
const MAX_SUMMARY_CHARS = 300

export interface BaikeToolOptions {
  source?: BaikeSource
  fetcher?: BaikeFetcher
}

/** 截断摘要到句号边界，避免播一半。 */
function trimSummary(summary: string, max: number): string {
  if (summary.length <= max) return summary
  const head = summary.slice(0, max)
  // 优先在最后一个句号/问号/叹号处收尾
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'))
  return (cut > max * 0.5 ? head.slice(0, cut + 1) : head).trim()
}

/**
 * 创建「查询百科词条」工具。
 * source 负责取数（默认百度搜索卡片，无 api-key），工具层负责格式化成口播文案。
 */
export function createBaikeTool(lang: Lang | string, options: BaikeToolOptions = {}) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const source = options.source ?? createDefaultBaikeSource()
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as BaikeFetcher)

  /** 一次查询 → 结构化词条（call 与语音直连共用，零二次抓取）。 */
  async function snapshot(args: { query: string }): Promise<BaikeEntry | null> {
    try {
      return await source.fetch(args.query, fetcher)
    } catch {
      return null
    }
  }

  /** 结构化词条 → 本地化口播文案。标题 + 摘要（截断到句号边界）。 */
  function format(entry: BaikeEntry | null, query: string): string {
    if (!entry || !entry.summary) {
      return prefix === 'en'
        ? `Sorry, I couldn't find information about "${query}".`
        : `暂时没查到「${query}」的百科信息。`
    }
    const body = trimSummary(entry.summary, MAX_SUMMARY_CHARS)
    const name = entry.title || query
    return prefix === 'en' ? `${name}. ${body}` : `${name}：${body}`
  }

  const descriptions: Record<string, string> = {
    zh: '查询百科词条、人物事迹、人物传记、生平简介。用户说「百科 XX」「查一下 XX 的百科」「XX 的事迹」「XX 的人物传」「介绍 XX 这个人」时调用，query 传人物名/词条名（如「李存勖」「人工智能」）。返回真实百科词条摘要，不要编造页面没有的内容。结果用于助手框显示和语音播报。',
    en: 'Look up encyclopedia entries, biographies and life stories. Call when the user says "wiki X", "look up X in the encyclopedia", "tell me about X" — pass the entry/person name as query (e.g. "Einstein"). Returns the real encyclopedia summary; never invent facts. The result is shown in the assistant panel and spoken aloud.',
  }

  return {
    name: BAIKE_TOOL_NAME,
    description: descriptions[prefix] ?? descriptions.zh,
    inputSchema: z.object({
      query: z.string().min(1).describe('人物名或词条名，如「李存勖」「人工智能」'),
    }),
    /** LLM function-call 入口：只返回本地化文本（契约与天气/好价一致）。 */
    call: async (args: { query?: string } = {}) => {
      const query = (args.query ?? '').trim()
      if (!query) return prefix === 'en' ? 'Please tell me what to look up.' : '请告诉我想查什么。'
      return format(await snapshot({ query }), query)
    },
    /** 语音直连入口：同一份查询同时拿到词条结构与文案。 */
    snapshotWithText: async (query: string): Promise<{ entry: BaikeEntry | null; text: string }> => {
      const entry = await snapshot({ query })
      return { entry, text: format(entry, query) }
    },
  }
}
