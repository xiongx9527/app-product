import type { ReportBlock } from '@/core/transport/types'

/**
 * 报表块类型的纯数据真相源（不 import 任何 .vue 组件，便于 node 环境单测）。
 * 组件映射在 registry.ts；这里只描述「支持哪些 type / 未知如何兜底」。
 * 新增类型时两处同步加：本清单 + registry 的组件映射。
 */
export type ReportBlockType = ReportBlock['type']

export const REPORT_BLOCK_TYPES: ReadonlyArray<ReportBlockType> = ['chart', 'table', 'image']

/** 未知 / 脏 type 的中性兜底标记。 */
export function isKnownReportBlockType(type: string): boolean {
  return (REPORT_BLOCK_TYPES as readonly string[]).includes(type)
}
