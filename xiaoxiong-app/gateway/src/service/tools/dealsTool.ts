import { z } from 'zod'
import type { Lang } from '../../protocol'
import {
  filterDeals,
  formatDeals,
  type DealsFetcher,
  type DealsOptions,
  type Deal,
} from '../deals'

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const DEALS_TOOL_NAME = 'query_deals'

interface CacheEntry {
  promise: Promise<Deal[]>
  expires: number
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/**
 * 创建「查询打折/优惠商品」工具：从注入的数据源抓取好价，按关键词本地过滤后返回本地化文本。
 * 数据源通过 DealsSource 抽象、由组合根注入，本工具不绑定任何具体站点。
 * 缓存：按页面 URL 做内存缓存（默认 60s），并发请求复用同一 Promise，避免重复抓取。
 * 失败降级：单页失败不影响其它页；全部失败返回「暂时查不到」；空结果返回「没找到」。
 * 不编造折扣：只播报页面上的现价与标签。第三方地址只来自数据源配置，工具不上报用户位置/设备号/关键词。
 */
export function createDealsTool(
  lang: Lang | string,
  options: DealsOptions
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const { source } = options
  const ttlEnv = Number(process.env.DEALS_CACHE_TTL_MS)
  const cacheTtlMs =
    options.cacheTtlMs ?? (Number.isFinite(ttlEnv) && ttlEnv > 0 ? ttlEnv : 60000)
  const pagesEnv = Number(process.env.DEALS_KEYWORD_PAGES)
  const pagesEnvOk = Number.isFinite(pagesEnv) && pagesEnv > 0 ? pagesEnv : 3
  const keywordPages = Math.max(1, Math.min(options.keywordPages ?? pagesEnvOk, 5))
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as DealsFetcher)
  const cache = new Map<string, CacheEntry>()

  function fetchPage(url: string): Promise<Deal[]> {
    const now = Date.now()
    const hit = cache.get(url)
    if (hit && hit.expires > now) return hit.promise
    const promise = (async () => {
      try {
        const res = await fetcher(url, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept-Language': 'zh-CN,zh;q=0.9',
          },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return source.parse(await res.text())
      } catch (e) {
        // 失败不缓存，下次调用可重试；并发复用仍走当前 promise。
        cache.delete(url)
        throw e
      }
    })()
    cache.set(url, { promise, expires: now + cacheTtlMs })
    return promise
  }

  const descriptions: Record<string, string> = {
    zh: '查询 / 搜索商品与实时打折好价。只要用户在问商品、东西、买卖、打折、优惠、折扣、便宜的东西、好价、特价、划不划算，或说「查询商品」「搜索商品」「有什么优惠」「XX 多少钱」等购物相关问题时都要调用——即使可能没有好价也要查，工具会返回「暂无」文案，不要因为怕没结果就不调用。可传 keyword 按商品关键词（如「耳机」「咖啡机」）在最近几页里筛选；不传则返回最新好价。返回页面上的现价与优惠标签，不要自行计算折扣率，也不要编造页面没有的信息。结果用于语音播报。',
    en: 'Query / search products and live deals. Call whenever the user asks about products, items, stuff, buying or selling, discounts, deals, bargains, cheap stuff, good prices, or says "search products", "any deals today", "what is on sale", "how much is X" — even if there may be no deals: the tool returns a "none found" message, so never skip the call. Pass keyword to filter recent pages by product (e.g. "headphones"); omit it to get the latest deals. Returns the prices and tags shown on the page — do not compute discounts yourself and never invent info not on the page. Use the result for a spoken reply.',
  }

  return {
    name: DEALS_TOOL_NAME,
    description: descriptions[prefix] ?? descriptions.zh,
    inputSchema: z.object({
      keyword: z
        .string()
        .optional()
        .describe('商品关键词，如「耳机」「咖啡机」；为空则返回最新好价'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe('返回条数，1–5，默认 3'),
    }),
    call: async (args: { keyword?: string; limit?: number } = {}) => {
      const keyword = args?.keyword?.trim() || undefined
      const limit = typeof args?.limit === 'number' ? args.limit : 3
      const pages = keyword ? keywordPages : 1
      const urls = Array.from({ length: pages }, (_, i) => source.pageUrl(i + 1))
      const settled = await Promise.allSettled(urls.map(fetchPage))
      const merged: Deal[] = []
      const seen = new Set<string>()
      let anyOk = false
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          anyOk = true
          for (const d of s.value) {
            const key = d.link || d.title
            if (seen.has(key)) continue
            seen.add(key)
            merged.push(d)
          }
        }
      }
      if (!merged.length) {
        if (!anyOk) {
          return prefix === 'en'
            ? "Couldn't fetch deal info right now."
            : '暂时查不到好价信息。'
        }
        return formatDeals(lang, [], keyword)
      }
      return formatDeals(lang, filterDeals(merged, keyword, limit), keyword)
    },
  }
}
