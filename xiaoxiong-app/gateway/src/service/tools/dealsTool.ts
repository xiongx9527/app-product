import { z } from 'zod'
import type { Lang } from '../../protocol'
import {
  filterDeals,
  formatDeals,
  type Deal,
  type DealDetail,
  type DealsFetcher,
  type DealsOptions,
  type DealsSource,
} from '../deals'

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const DEALS_TOOL_NAME = 'query_deals'

interface CacheEntry {
  promise: Promise<Deal[]>
  expires: number
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** collectDeals 的运行上下文：由 createDealsTool 构造，共享同一份 fetchPage 缓存。 */
export interface DealsContext {
  source: DealsSource
  /** 第二参可选：搜索页用 source.parseSearch，缺省 source.parse（缓存 key 仍是 URL）。 */
  fetchPage: (url: string, parse?: (html: string) => Deal[]) => Promise<Deal[]>
  keywordPages: number
}

/** 一次查询同时产出的结果：口播文本 + 结构化列表（工具 call 与语音直连共用，零二次抓取）。 */
export interface DealsSnapshot {
  text: string
  deals: Deal[]
}

/**
 * 抓取 + 去重 + 关键词过滤，返回结构化 Deal[] 与「是否至少有一页抓取成功」。
 * 抽成导出纯函数便于单测；语音直连与工具 call 都走它，共用同一 fetchPage 缓存，
 * 一次查询即可同时得到口播文本和要下发给客户端的编号列表，不会抓两遍。
 */
export async function collectDeals(
  ctx: DealsContext,
  args: { keyword?: string; limit?: number; dealsOnly?: boolean } = {},
): Promise<{ deals: Deal[]; anyOk: boolean }> {
  const keyword = args.keyword?.trim() || undefined
  const limit = typeof args.limit === 'number' ? args.limit : 3
  const pages = keyword ? ctx.keywordPages : 1
  // 意图：dealsOnly=true（用户明确说优惠/打折/折扣/好价）→ 限定好价 feed；
  // 纯商品搜索（默认）→ 优先站内 tag 真搜索，能搜到 feed 之外的商品。
  // 默认走搜索：LLM 纯商品查询不传参数时就是真搜索，不会悄悄退回「只有好价」；
  // 语音直连（dealsControl）拦的都是好价信号句，显式传 dealsOnly=true 限定好价。
  const dealsOnly = args.dealsOnly === true
  // tag 搜索页结果已与关键词相关，跳过本地二次过滤，只去重 + 截断。
  if (!dealsOnly && keyword && ctx.source.searchUrl) {
    const searchUrls: string[] = []
    for (let i = 1; i <= pages; i++) {
      const u = ctx.source.searchUrl(keyword, i)
      if (u) searchUrls.push(u)
    }
    const settled = await Promise.allSettled(
      searchUrls.map((u) => ctx.fetchPage(u, ctx.source.parseSearch ?? ctx.source.parse))
    )
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
    if (merged.length) {
      return { deals: merged.slice(0, limit), anyOk }
    }
    // tag 页 404 / WAF 挑战 / 无结果：回退「feed + 本地过滤」兜底（结果仍与关键词相关）。
  }
  const urls = Array.from({ length: pages }, (_, i) => ctx.source.pageUrl(i + 1))
  // 注意不能直接 map(ctx.fetchPage)：map 会把 index 传进第二参 parse，数字不是函数
  const settled = await Promise.allSettled(urls.map((u) => ctx.fetchPage(u)))
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
  return { deals: filterDeals(merged, keyword, limit), anyOk }
}

/**
 * 创建「查询打折/优惠商品」工具：从注入的数据源抓取好价，按关键词本地过滤后返回本地化文本。
 * 数据源通过 DealsSource 抽象、由组合根注入，本工具不绑定任何具体站点。
 * 缓存：按页面 URL 做内存缓存（默认 60s），并发请求复用同一 Promise，避免重复抓取。
 * 失败降级：单页失败不影响其它页；全部失败返回「暂时查不到」；空结果返回「没找到」。
 * 不编造折扣：只播报页面上的现价与标签。第三方地址只来自数据源配置，工具不上报用户位置/设备号/关键词。
 *
 * 除 call（LLM function-call 用，返回文本）外，额外暴露 snapshot()：一次查询同时给出
 * 口播文本与结构化 Deal[]，供语音直连复用——语音选号与详情卡片需要留住列表，
 * 但不能因此再抓一次页面。
 */
export function createDealsTool(
  lang: Lang | string,
  options: DealsOptions
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const { source } = options
  // 默认推荐条数：来自客户端设置页（session.start.recommend.dealsCount），缺省 3，范围 1–10。
  const defaultLimit = Math.min(10, Math.max(1, Math.floor(options.defaultLimit ?? 3)))
  const ttlEnv = Number(process.env.DEALS_CACHE_TTL_MS)
  const cacheTtlMs =
    options.cacheTtlMs ?? (Number.isFinite(ttlEnv) && ttlEnv > 0 ? ttlEnv : 60000)
  const pagesEnv = Number(process.env.DEALS_KEYWORD_PAGES)
  const pagesEnvOk = Number.isFinite(pagesEnv) && pagesEnv > 0 ? pagesEnv : 3
  const keywordPages = Math.max(1, Math.min(options.keywordPages ?? pagesEnvOk, 5))
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as DealsFetcher)
  const cache = new Map<string, CacheEntry>()

  function fetchPage(
    url: string,
    parse: (html: string) => Deal[] = source.parse
  ): Promise<Deal[]> {
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
        return parse(await res.text())
      } catch (e) {
        // 失败不缓存，下次调用可重试；并发复用仍走当前 promise。
        cache.delete(url)
        throw e
      }
    })()
    cache.set(url, { promise, expires: now + cacheTtlMs })
    return promise
  }

  const ctx: DealsContext = { source, fetchPage, keywordPages }

  /** 一次查询 → 口播文本 + 结构化列表。call 与语音直连都复用它，零二次抓取。 */
  async function snapshot(
    args: { keyword?: string; limit?: number; dealsOnly?: boolean } = {},
  ): Promise<DealsSnapshot> {
    const keyword = args.keyword?.trim() || undefined
    const resolved = {
      ...args,
      limit: typeof args.limit === 'number' ? args.limit : defaultLimit,
    }
    const { deals, anyOk } = await collectDeals(ctx, resolved)
    const text =
      !deals.length && !anyOk
        ? prefix === 'en'
          ? "Couldn't fetch deal info right now."
          : '暂时查不到好价信息。'
        : formatDeals(lang, deals, keyword)
    return { text, deals }
  }

  const descriptions: Record<string, string> = {
    zh: '查询商品 / 搜索商品 / 查好价。用户问商品、东西、买卖、XX 多少钱，或说「搜索耳机」「查询商品」这类纯商品查询时调用：走站内真搜索，能搜到普通商品，不限于是好价商品——此时不要传 dealsOnly。用户明确说优惠、打折、折扣、好价、特价、促销、秒杀、划算、便宜时才传 dealsOnly=true，限定查好价商品（没有好价就返回「暂无」，不要因为怕没结果就不调用）。keyword 传商品核心词（如「耳机」「咖啡机」）；不传 keyword 且 dealsOnly=true 返回最新好价。返回页面上的现价与优惠标签，不要自行计算折扣率，也不要编造页面没有的信息。结果用于语音播报。',
    en: 'Search products / query deals. Call whenever the user asks about products, items, stuff, "how much is X", "search headphones" or other plain product searches: this hits the on-site search and can find ordinary products, not only deals — do NOT pass dealsOnly then. Pass dealsOnly=true ONLY when the user explicitly says discount/deal/on sale/bargain words (优惠/打折/折扣/好价/特价/促销) to restrict to deal items; if none found the tool returns a "none" message, so never skip the call. keyword is the product term (e.g. "headphones"); omit keyword with dealsOnly=true to get the latest deals. Returns the prices and tags shown on the page — do not compute discounts yourself and never invent info not on the page. Use the result for a spoken reply.',
  }

  return {
    name: DEALS_TOOL_NAME,
    description: descriptions[prefix] ?? descriptions.zh,
    inputSchema: z.object({
      keyword: z
        .string()
        .optional()
        .describe('商品关键词，如「耳机」「咖啡机」；为空且 dealsOnly=true 则返回最新好价'),
      dealsOnly: z
        .boolean()
        .optional()
        .describe('仅当用户明确提到优惠/打折/折扣/好价/特价/促销等优惠意图时传 true（限定好价商品）；纯商品搜索不要传'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('返回条数，1–10，默认 3'),
    }),
    /** LLM function-call 入口：只返回本地化文本（契约不变）。 */
    call: async (
      args: { keyword?: string; limit?: number; dealsOnly?: boolean } = {},
    ) => (await snapshot(args)).text,
    /** 语音直连入口：同一份查询同时拿到文本与结构化列表，供编号选择/详情卡片使用。 */
    snapshot,
  }
}

/** 详情页缓存：同一件商品不该反复抓（详情页 ~230KB）。按 URL 缓存，跨会话复用。 */
const detailCache = new Map<string, { promise: Promise<DealDetail | null>; expires: number }>()
const DETAIL_CACHE_TTL_MS = 10 * 60_000
const DETAIL_TIMEOUT_MS = 1500

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('detail timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * 选中某件后补抓它的**详情页**（源特有解析，见 `DealsSource.parseDetail`）。
 * 拿到的仍是源无关的 `DealDetail`（优惠说明/品牌/权威时间/大图），由 `toDetailItems`
 * 统一映射成协议 `fields[]`——客户端始终不知道数据来自哪个站点、哪个页面。
 *
 * 任何失败（源不支持 / 超时 / 非 200 / 解析不出）一律返回 null，调用方用列表数据照常展示：
 * 详情页只是「更全」，不能成为卡片能否打开的依赖。
 */
export async function enrichDeal(
  source: DealsSource,
  deal: Deal,
  fetcher: DealsFetcher = globalThis.fetch as unknown as DealsFetcher,
  timeoutMs = DETAIL_TIMEOUT_MS,
): Promise<DealDetail | null> {
  const parse = source.parseDetail
  const url = source.detailUrl?.(deal)
  if (!url || !parse) return null

  const now = Date.now()
  const hit = detailCache.get(url)
  if (hit && hit.expires > now) return hit.promise

  const promise = (async (): Promise<DealDetail | null> => {
    try {
      const res = await withTimeout(fetcher(url, { headers: { 'user-agent': USER_AGENT } }), timeoutMs)
      if (!res.ok) return null
      const detail = parse(await res.text())
      return Object.keys(detail).length ? detail : null
    } catch {
      return null
    }
  })()
  detailCache.set(url, { promise, expires: now + DETAIL_CACHE_TTL_MS })
  return promise
}
