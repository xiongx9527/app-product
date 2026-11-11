import type { Deal } from './deals'
import type { MemoryEntry } from './dataService'

/**
 * 「推荐几件打折的」这类泛查询原本只取列表前几条，跟用户是谁无关。
 * 这里用长期记忆做**确定性**偏好排序：记忆是自由文本（「常买：猫粮、咖啡豆」
 * 「喜欢喝咖啡」），没有分词器就按分隔符切 + 中文取 2 字片段，命中商品标题/标签/商城的排前面。
 *
 * 刻意不调 LLM：排序是纯函数、可单测、零延迟，也符合「能确定性处理就别调模型」的约定。
 */

/** 空泛词：不是商品偏好，参与匹配只会误命中。 */
const STOP = new Set([
  '喜欢', '爱好', '偏好', '习惯', '经常', '常常', '平时', '一般', '比较', '特别',
  '我的', '我们', '用户', '东西', '商品', '购物', '想要', '需要', '可以', '应该',
  '觉得', '感觉', '之类', '等等', '还有', '一个', '这个', '那个', '什么', '怎么',
  '早上', '晚上', '中午', '周末', '每天', '时间',
])

const SEP = /[^\p{L}\p{N}]+/u
const CJK = /^[\u4e00-\u9fa5]+$/

/**
 * 从长期记忆里抽偏好关键词。中文没有分词，长片段再拆成 2 字片段（「喜欢喝咖啡」→「咖啡」），
 * 英文/数字按分隔符切即可。去重后最多 max 个，避免长记忆把匹配面撑爆。
 */
export function preferenceKeywords(entries: readonly MemoryEntry[], max = 30): string[] {
  const out = new Set<string>()
  const add = (w: string) => {
    if (w.length < 2 || w.length > 12) return
    if (STOP.has(w)) return
    out.add(w)
  }
  for (const e of entries) {
    for (const raw of `${e.key} ${e.value}`.split(SEP)) {
      const w = raw.trim()
      if (!w) continue
      add(w)
      if (CJK.test(w) && w.length > 4) {
        for (let i = 0; i + 2 <= w.length; i += 1) add(w.slice(i, i + 2))
      }
      if (out.size >= max) return [...out]
    }
  }
  return [...out]
}

/** 单件商品的偏好得分：标题/标签/商城命中关键词的个数，长词权重更高。 */
function score(deal: Deal, keywords: readonly string[]): number {
  const hay = `${deal.title} ${deal.tags.join(' ')} ${deal.mall}`
  let s = 0
  for (const k of keywords) {
    if (hay.includes(k)) s += k.length >= 3 ? 2 : 1
  }
  return s
}

/**
 * 按记忆偏好挑要推荐的条目：得分高的在前，同分保持原顺序（稳定），取前 limit 条。
 * 没有记忆或全都没命中时，等价于「取前 limit 条」——行为与没有记忆功能时一致。
 */
export function pickDeals(deals: readonly Deal[], keywords: readonly string[], limit = 3): Deal[] {
  if (!keywords.length) return deals.slice(0, limit)
  return deals
    .map((d, i) => ({ d, i, s: score(d, keywords) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.d)
}
