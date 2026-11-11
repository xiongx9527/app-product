import type { MediaDetail } from '@/core/transport/types'
import type { ActionNotify, ShareAction } from '@/core/share/actions'
import { t } from '@/core/i18n'
import { detailActions } from './actions'

/**
 * 内容类型（kind）→ 元数据表。容器与 useAssistant 的状态结构不感知 kind：
 * 新增一类只加一个表项 + 协议 union 分支 + 一个内容组件，
 * 不改 DetailCard 容器、不改 core/share、不改 detailCard 状态结构。
 */
export interface DetailKindMeta {
  /** 卡片标题（i18n） */
  title: (detail: MediaDetail) => string
  /** 该类的操作栏项；容器只渲染数组，不写死项 */
  actions: (detail: MediaDetail, notify: ActionNotify) => ShareAction[]
}

/** 未知 kind 的中性兜底：不让新类型或脏数据把卡片弄崩。 */
const neutral: DetailKindMeta = {
  title: () => t('detail.title'),
  actions: () => [],
}

export const detailRegistry: Record<string, DetailKindMeta> = {
  deals: {
    title: (d) => t(d.selectedIndex == null ? 'detail.listTitle' : 'detail.title'),
    actions: detailActions,
  },
  project: {
    title: (d) => t(d.selectedIndex == null ? 'detail.projectListTitle' : 'detail.title'),
    actions: detailActions,
  },
  // 预留：text（纯文本）/ chart / report（图表报表）/ webview（嵌入页）
  // 各加一个表项即可；列表项形状不变，内容组件与操作栏都不用改。
}

export function resolveDetailMeta(kind: string): DetailKindMeta {
  return detailRegistry[kind] ?? neutral
}
