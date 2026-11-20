import type { Deal } from './deals'

/**
 * 好价偏好排序（deals_skill 域内）：用长期记忆里的偏好关键词对商品确定性排序，
 * 得分高的在前、同分保持原序，取前 limit 条。纯函数、零延迟、不调 LLM。
 * 没有记忆或全都没命中时等价于「取前 limit 条」，行为与无个性化一致。
 */

/** 条目得分：命中关键词的个数即得分，长词权重更高。 */
function score(hay: string, keywords: readonly string[]): number {
  let s = 0
  for (const k of keywords) {
    if (hay.includes(k)) s += k.length >= 3 ? 2 : 1
  }
  return s
}

/** 通用偏好排序：条目类型由调用方给出可匹配文本，本函数不认识任何业务字段。 */
export function rankByPreference<T>(
  items: readonly T[],
  keywords: readonly string[],
  textOf: (item: T) => string,
  limit: number,
): T[] {
  if (!keywords.length) return items.slice(0, limit)
  return items
    .map((item, i) => ({ item, i, s: score(textOf(item), keywords) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item)
}

/** 商品偏好挑选。 */
export function pickDeals(deals: readonly Deal[], keywords: readonly string[], limit = 3): Deal[] {
  return rankByPreference(
    deals,
    keywords,
    (d) => `${d.title} ${d.tags.join(' ')} ${d.mall}`,
    limit,
  )
}
