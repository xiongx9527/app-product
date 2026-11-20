/**
 * 好价查询数据层（deals_skill 域内）：抓取 + 去重 + 关键词过滤 + 多源降级 + 详情补抓。
 *
 * 这是「技能取数」而非 LLM 工具——deals skill 用它抓真实商品，测试注入桩替换。
 * 缓存按 URL（含 UA），并发复用同一 Promise，避免重复抓取；反爬/WAF 页冷却该源并切换。
 * 不编造折扣：只播报页面上的现价与标签。
 */
import {
  filterDeals,
  formatDeals,
  type Deal,
  type DealDetail,
  type DealsFetcher,
  type DealsOptions,
  type DealsSource,
} from './deals'
import {
  isSourceCooling,
  markSourceCooldown,
  clearSourceCooldown,
  looksAntiBot,
} from './deals/sourceCooldown'

interface CacheEntry {
  promise: Promise<Deal[]>
  expires: number
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** collectDeals 的运行上下文：共享同一份 fetchPage 缓存。 */
export interface DealsContext {
  source: DealsSource
  fetchPage: (url: string, parse?: (html: string) => Deal[], userAgent?: string, sourceName?: string) => Promise<Deal[]>
  keywordPages: number
}

/** 抓取 + 去重 + 关键词过滤，返回结构化 Deal[] 与「是否至少有一页抓取成功」。 */
export async function collectDeals(
  ctx: DealsContext,
  args: { keyword?: string; limit?: number; dealsOnly?: boolean } = {},
): Promise<{ deals: Deal[]; anyOk: boolean }> {
  const keyword = args.keyword?.trim() || undefined
  const limit = typeof args.limit === 'number' ? args.limit : 3
  const pages = keyword ? ctx.keywordPages : 1
  const dealsOnly = args.dealsOnly === true
  if (!dealsOnly && keyword && ctx.source.searchUrl) {
    const searchUrls: string[] = []
    for (let i = 1; i <= pages; i += 1) {
      const u = ctx.source.searchUrl(keyword, i)
      if (u) searchUrls.push(u)
    }
    const settled = await Promise.allSettled(
      searchUrls.map((u) => ctx.fetchPage(u, ctx.source.parseSearch ?? ctx.source.parse, ctx.source.userAgent, ctx.source.name))
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
      return {
        deals: ctx.source.filterSearch ? filterDeals(merged, keyword, limit) : merged.slice(0, limit),
        anyOk,
      }
    }
  }
  const urls = Array.from({ length: pages }, (_, i) => ctx.source.pageUrl(i + 1))
  const settled = await Promise.allSettled(urls.map((u) => ctx.fetchPage(u, ctx.source.parse, ctx.source.userAgent, ctx.source.name)))
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
 * 构造好价查询器：一次查询同时给出口播文本 + 结构化列表（选号/详情共用，零二次抓取）。
 * 多源依次尝试，主源没结果/被反爬就冷却切换，全失败才回兜底文案。
 */
export function createDealsQuery(lang: string, options: DealsOptions) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const { source } = options
  const defaultLimit = Math.min(10, Math.max(1, Math.floor(options.defaultLimit ?? 3)))
  const ttlEnv = Number(process.env.DEALS_CACHE_TTL_MS)
  const cacheTtlMs = options.cacheTtlMs ?? (Number.isFinite(ttlEnv) && ttlEnv > 0 ? ttlEnv : 60000)
  const pagesEnv = Number(process.env.DEALS_KEYWORD_PAGES)
  const pagesEnvOk = Number.isFinite(pagesEnv) && pagesEnv > 0 ? pagesEnv : 3
  const keywordPages = Math.max(1, Math.min(options.keywordPages ?? pagesEnvOk, 5))
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as DealsFetcher)
  const cache = new Map<string, CacheEntry>()

  function fetchPage(url: string, parse: (html: string) => Deal[], userAgent?: string, sourceName?: string): Promise<Deal[]> {
    const cacheKey = `${userAgent ?? 'pc'}|${url}`
    const now = Date.now()
    const hit = cache.get(cacheKey)
    if (hit && hit.expires > now) return hit.promise
    const promise = (async () => {
      try {
        const res = await fetcher(url, {
          headers: { 'User-Agent': userAgent ?? USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const html = await res.text()
        if (sourceName && looksAntiBot(html)) {
          markSourceCooldown(sourceName)
          throw new Error(`anti-bot page from ${sourceName}`)
        }
        return parse(html)
      } catch (e) {
        cache.delete(cacheKey)
        throw e
      }
    })()
    cache.set(cacheKey, { promise, expires: now + cacheTtlMs })
    return promise
  }

  const allSources = [source, ...(options.fallbackSources ?? [])]

  return async function query(
    args: { keyword?: string; limit?: number; dealsOnly?: boolean } = {},
  ): Promise<{ text: string; deals: Deal[] }> {
    const keyword = args.keyword?.trim() || undefined
    const resolved = { ...args, limit: typeof args.limit === 'number' ? args.limit : defaultLimit }
    let anyFetched = false
    for (const src of allSources) {
      if (isSourceCooling(src.name)) continue
      const srcCtx: DealsContext = {
        source: src,
        fetchPage: (url, parse, ua) => fetchPage(url, parse ?? src.parse, ua ?? src.userAgent, src.name),
        keywordPages,
      }
      try {
        const { deals, anyOk } = await collectDeals(srcCtx, resolved)
        anyFetched = anyFetched || anyOk
        if (deals.length) {
          clearSourceCooldown(src.name)
          return { text: formatDeals(lang, deals, keyword), deals }
        }
      } catch { /* 换下一个源 */ }
    }
    const text = !anyFetched
      ? prefix === 'en' ? "Couldn't fetch deal info right now." : '暂时查不到好价信息。'
      : formatDeals(lang, [], keyword)
    return { text, deals: [] }
  }
}

/** 详情页缓存：同一件商品不反复抓（~230KB）。 */
const detailCache = new Map<string, { promise: Promise<DealDetail | null>; expires: number }>()
const DETAIL_CACHE_TTL_MS = 10 * 60_000
const DETAIL_TIMEOUT_MS = 1500

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('detail timeout')), ms)
    p.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

/** 选中某件后补抓详情页；失败返回 null（卡片用列表数据照常展示）。 */
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
