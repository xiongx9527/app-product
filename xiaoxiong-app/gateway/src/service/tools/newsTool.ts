import type { NewsFetcher, NewsOptions, NewsResult } from '../news'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const BAIDU_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}
const TIMEOUT_MS = 6000

interface CacheEntry {
  promise: Promise<NewsResult>
  expires: number
}

/**
 * 创建新闻查询工具：数据源通过 NewsSource 抽象注入（默认百度新闻频道，未来可换源），
 * 抓取器可注入桩便于测试。按 URL 做 TTL 内存缓存（默认 60s），并发复用同一 Promise。
 * 任何抓取失败都安静降级成 {ok:false}，由 formatNews 出诚实兜底文案，不编造新闻。
 */
export function createNewsTool(options: NewsOptions) {
  const { source } = options
  const fetcher: NewsFetcher = options.fetcher ?? (globalThis.fetch as unknown as NewsFetcher)
  const cacheTtlMs =
    options.cacheTtlMs ?? (Number(process.env.NEWS_CACHE_TTL_MS) || 60000)
  const limit = Math.max(1, Math.min(options.limit ?? 5, 10))
  const cache = new Map<string, CacheEntry>()

  function fetchPage(url: string): Promise<NewsResult> {
    const now = Date.now()
    const hit = cache.get(url)
    if (hit && hit.expires > now) return hit.promise
    const promise = (async (): Promise<NewsResult> => {
      try {
        const init: { headers: Record<string, string>; signal?: AbortSignal } = { headers: BAIDU_HEADERS }
        // AbortSignal.timeout 旧 Node 可能没有，做能力探测（照 music/baidu 的写法）
        if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) {
          init.signal = (AbortSignal as unknown as { timeout(ms: number): AbortSignal }).timeout(TIMEOUT_MS)
        }
        const res = await fetcher(url, init)
        if (!res.ok) return { headlines: [], ok: false }
        const html = await res.text()
        // 反爬验证页：有验证特征即视为抓取不可用，不解析、不编造
        if (/百度安全验证|请输入验证码|网络不给力/.test(html)) {
          return { headlines: [], ok: false }
        }
        return { headlines: source.parse(html), ok: true }
      } catch {
        return { headlines: [], ok: false }
      }
    })()
    cache.set(url, { promise, expires: now + cacheTtlMs })
    return promise
  }

  /** 一次查询：keyword=null 泛播头条；非 null 走话题搜索。 */
  async function query(keyword: string | null): Promise<NewsResult> {
    // 失败不该缓存（下次可重试）：fetchPage 内部已把失败包成 ok:false，这里在TTL到期后再清
    const result = await fetchPage(source.headlinesUrl(keyword))
    if (!result.ok) cache.delete(source.headlinesUrl(keyword))
    return result
  }

  return { name: source.name, query, limit }
}
