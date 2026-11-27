import type { Component } from 'vue'
import ReportChart from './blocks/ReportChart.vue'
import ReportTable from './blocks/ReportTable.vue'
import ReportImage from './blocks/ReportImage.vue'
import { isKnownReportBlockType } from './blockTypes'

/**
 * 报表块类型（block.type）→ 渲染组件注册表。
 * 对应 java-product 前端的 getChartInstance(type) 工厂：容器不认识任何业务字段，
 * 只按 type 查表取组件渲染。新增块类型（text/chart/kv/webview…）＝协议加一个 ReportBlock
 * 分支 + blockTypes 清单加一项 + 这里加一项 + 一个小组件，不改容器、不改网关骨架。
 */
export interface ReportBlockMeta {
  component: Component
}

export const reportBlockRegistry: Record<string, ReportBlockMeta> = {
  chart: { component: ReportChart },
  table: { component: ReportTable },
  image: { component: ReportImage },
}

/** 未知 / 脏 type 的中性兜底：跳过不渲染，不让新类型或坏数据把卡片弄崩。 */
export function resolveReportBlock(type: string): ReportBlockMeta | null {
  if (!isKnownReportBlockType(type)) return null
  return reportBlockRegistry[type] ?? null
}
