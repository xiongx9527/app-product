import { z } from 'zod'
import { rankByPreference } from '../dealsPreference'
import type { Lang } from '../../protocol'
import {
  filterProjects,
  formatProjects,
  projectsToDetailItems,
  type OpenSourceFetcher,
  type OpenSourceOptions,
  type OpenSourceProject,
} from '../opensource'

/** 工具名固定，作为 LLM 函数调用的标识，不要本地化。 */
export const OPENSOURCE_TOOL_NAME = 'query_opensource'

interface CacheEntry {
  promise: Promise<OpenSourceProject[]>
  expires: number
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/**
 * 创建「查询开源工具/软件」工具：从注入的数据源抓取条目，按关键词本地过滤后返回本地化文本。
 * 数据源通过 OpenSourceSource 抽象、由组合根注入，本工具不绑定任何具体站点。
 * 缓存：按页面 URL 做内存缓存（默认 60s），并发请求复用同一 Promise，避免重复抓取。
 * 失败降级：单页失败不影响其它页；全部失败返回「暂时查不到」；空结果返回「没找到」。
 * 不编造：只播报数据源真实返回的字段，不编造没有返回的字段。
 * 关键词只在网关本地过滤，不上报给第三方；第三方地址只来自数据源配置。
 */
export function createOpenSourceTool(
  lang: Lang | string,
  options: OpenSourceOptions
) {
  const prefix = (lang || 'zh-CN').toLowerCase().split(/[-_]/)[0]
  const { source } = options
  // 默认推荐条数：来自客户端设置页（session.start.recommend.opensourceCount），缺省 3，范围 1–10。
  const defaultLimit = Math.min(10, Math.max(1, Math.floor(options.defaultLimit ?? 3)))
  const ttlEnv = Number(process.env.OPENSOURCE_CACHE_TTL_MS)
  const cacheTtlMs =
    options.cacheTtlMs ?? (Number.isFinite(ttlEnv) && ttlEnv > 0 ? ttlEnv : 60000)
  const pagesEnv = Number(process.env.OPENSOURCE_KEYWORD_PAGES)
  const pagesEnvOk = Number.isFinite(pagesEnv) && pagesEnv > 0 ? pagesEnv : 3
  const keywordPages = Math.max(1, Math.min(options.keywordPages ?? pagesEnvOk, 5))
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as OpenSourceFetcher)
  // 结构化结果回调：由组合根接到「下发客户端」，工具本身不碰传输层
  const onResults = options.onResults
  const cache = new Map<string, CacheEntry>()

  function fetchPage(url: string): Promise<OpenSourceProject[]> {
    const now = Date.now()
    const hit = cache.get(url)
    if (hit && hit.expires > now) return hit.promise
    const promise = (async () => {
      try {
        const res = await fetcher(url, {
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
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
    zh: '查询并推荐开源工具、软件、项目。触发口径统一为「开源」：用户提到「开源」「开源项目」「开源工具」「开源软件」「开源数据库」「开源XXX」等，或问「有什么好的数据库」「推荐个 AI 工具」「大数据有什么框架」「最近有什么新项目」这类找工具/软件/项目的求推荐问题时，都调用本工具，用开源项目来回答，不要自己凭记忆罗列。可传 keyword 给核心品类词（如「数据库」「AI」「编辑器」）；不带具体品类的「开源项目/开源工具」也调用、keyword 留空返回最新收录。不要在纯知识问答（如「数据库是什么」「讲讲 AI 原理」）时调用。返回带 1、2、3、4 编号的项目名、一句话定位、编程语言与简介，不要编造页面没有返回的字段。播报时逐条念出编号，方便用户说「第2个」选择；用户随后说编号时，结合上一轮列表回答对应项目，不要再查一次、也不要当成点歌。结果用于语音播报。',
    en: 'Query and recommend open-source tools / software / projects. Trigger on anything about "open source": "open source / open-source projects / open-source tools / open-source software / open-source databases / open-source XXX", or recommendation requests like "any good databases", "recommend an AI tool", "big-data frameworks", "what new projects are there". Always answer these with open-source projects from this tool rather than listing from memory. Pass keyword as the core category (e.g. "database", "AI", "editor"); for generic "open-source projects/tools" call with keyword empty to get the latest. Do NOT call for pure knowledge questions ("what is a database", "explain how AI works"). Returns numbered (1, 2, 3, 4) items with name, tagline, language and summary — never invent fields not present in the data. Read the numbers out loud so the user can pick one by saying "number 2"; when they reply with an ordinal, answer from the previous list instead of querying again or treating it as a song request. Use the result for a spoken reply.',
  }

  return {
    name: OPENSOURCE_TOOL_NAME,
    description: descriptions[prefix] ?? descriptions.zh,
    inputSchema: z.object({
      keyword: z
        .string()
        .optional()
        .describe('核心品类词，如「数据库」「AI」「编辑器」「大数据」；「开源项目/开源工具」这类不限品类的可留空，返回最新开源项目'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('返回条数，1–10，默认 3'),
    }),
    call: async (args: { keyword?: string; limit?: number } = {}) => {
      const keyword = args?.keyword?.trim() || undefined
      const limit = typeof args?.limit === 'number' ? args.limit : defaultLimit
      const pages = keyword ? keywordPages : 1
      const urls = Array.from({ length: pages }, (_, i) => source.pageUrl(i + 1))
      const settled = await Promise.allSettled(urls.map(fetchPage))
      const merged: OpenSourceProject[] = []
      const seen = new Set<string>()
      let anyOk = false
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          anyOk = true
          for (const p of s.value) {
            const key = p.link || `${p.name}|${p.title}`
            if (seen.has(key)) continue
            seen.add(key)
            merged.push(p)
          }
        }
      }
      if (!merged.length) {
        if (!anyOk) {
          return prefix === 'en'
            ? "Couldn't fetch open-source projects right now."
            : '暂时查不到开源工具/软件信息。'
        }
        return formatProjects(lang, [], keyword)
      }
      // 泛推荐（用户没指定品类）按长期记忆偏好排序；带品类时用户已指定，保持关键词过滤结果。
      // 与商品共用同一套确定性排序，不调 LLM。
      let prefKeywords: string[] = []
      if (!keyword) {
        try {
          prefKeywords = (await options.getPreferenceKeywords?.()) ?? []
        } catch {
          // 记忆读失败不阻断推荐：退回「取最新」的普通结果
          prefKeywords = []
        }
      }
      const picked = prefKeywords.length
        ? rankByPreference(
            merged,
            prefKeywords,
            (p) => `${p.name} ${p.title} ${p.detail} ${p.language} ${p.os}`,
            limit,
          )
        : filterProjects(merged, keyword, limit)
      // 与口播同一份结果：客户端卡片与语音编号一一对应，用户说「第2个」看到的正是第 2 张卡。
      // 结构是统一的 DetailItem，客户端不知道数据来自哪个源。
      if (picked.length) {
        onResults?.(projectsToDetailItems(picked, lang))
      }
      return formatProjects(lang, picked, keyword)
    },
  }
}
