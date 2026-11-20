import type { DealsSource } from './types'
import { createSmzdmSource } from './smzdm'
import { createZhizhizhiSource } from './zhizhizhi/zhizhizhiSource'

export type { Deal, DealDetail, DealsSource, DealsFetcher, DealsOptions, DealsSnapshot } from './types'
export { formatDeals, filterDeals, splitKeywordTerms } from './types'
export { createSmzdmSource, parseDeals, parseTagDeals, parseDealDetail } from './smzdm'
export { createZhizhizhiSource, parseZhizhizhiHtml } from './zhizhizhi/zhizhizhiSource'
export { toDetailItems } from './detail'

/**
 * 好价数据源工厂（多源可切换）：默认主源=值值值（设备网络可访问，smzdm 已被 WAF 普遍拦截），
 * 备用源=什么值得买。DEALS_SOURCE=smzdm 可反转主备（若以后 WAF 解除）。
 * 主源没结果/被反爬会冷却并自动切到备用源（见 tools/dealsTool snapshot）。
 */
export function createDealsSource(): DealsSource {
  return createDealsAllSources()[0]
}

/** 主源 + 备用源列表（顺序即尝试顺序）。 */
export function createDealsAllSources(): DealsSource[] {
  const which = (process.env.DEALS_SOURCE ?? '').toLowerCase()
  return which === 'smzdm'
    ? [createSmzdmSource(), createZhizhizhiSource()]
    : [createZhizhizhiSource(), createSmzdmSource()]
}

