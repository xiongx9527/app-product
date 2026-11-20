import type { MemoryEntry } from '../dataService'

/**
 * 从长期记忆抽偏好关键词（通用能力，非好价专属）。中文没有分词，长片段再拆成 2 字片段
 * （「喜欢喝咖啡」→「咖啡」），英文/数字按分隔符切。去重后最多 max 个，避免长记忆撑爆匹配面。
 * 纯函数、不调 LLM——记忆是自由文本，确定性切词够用（能确定性处理就别调模型）。
 */

/** 空泛词：不是偏好，参与匹配只会误命中。 */
const STOP = new Set([
  '喜欢', '爱好', '偏好', '习惯', '经常', '常常', '平时', '一般', '比较', '特别',
  '我的', '我们', '用户', '东西', '商品', '购物', '想要', '需要', '可以', '应该',
  '觉得', '感觉', '之类', '等等', '还有', '一个', '这个', '那个', '什么', '怎么',
  '早上', '晚上', '中午', '周末', '每天', '时间',
])

const SEP = /[^\p{L}\p{N}]+/u
const CJK = /^[\u4e00-\u9fa5]+$/

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
