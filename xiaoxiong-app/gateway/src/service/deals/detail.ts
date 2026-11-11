import type { DetailItem } from '../../protocol'
import type { Deal } from './types'

/**
 * 数据源模型 → 协议层稳定契约的映射（网关侧适配）。
 *
 * 这一步是「换源不出问题」的关键：内部 `Deal` 可以随数据源变化增删字段，
 * 但下发给客户端的 `DetailItem` 结构稳定。换数据源只改这里，不动事件类型、
 * 不动客户端详情卡片组件。除 index/title 外全部可选，缺省值收敛为空/未定义，
 * 让客户端对字段缺失天然容忍（新源没有图片/商城/标签也不会白屏）。
 */
export function toDetailItems(deals: readonly Deal[]): DetailItem[] {
  return deals.map((d, i) => ({
    index: i + 1,
    title: d.title,
    price: d.price || undefined,
    mall: d.mall || undefined,
    tags: d.tags?.length ? d.tags : undefined,
    time: d.time,
    link: d.link || undefined,
    image: d.image || undefined,
  }))
}
