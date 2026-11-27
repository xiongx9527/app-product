/**
 * 报表工具栏的通用操作模型（纯 ts，不 import .vue，便于 node 单测）。
 *
 * 参照本项目的 ShareAction（core/share/actions.ts）与 java-product 的 ChartBlock 工具栏：
 * 容器只按数组渲染按钮，不认识任何业务词（图表/明细/下载都是数据）。
 * ReportToolbar 负责把本模型渲染成 segmented 下拉/按钮/关闭，不写死任何项。
 */

export type ReportActionKind = 'button' | 'select' | 'close'

export interface ReportActionChild {
  key: string
  label: string
  glyph?: string
  active?: boolean
  run: () => void | Promise<void>
}

export interface ReportAction {
  /** 唯一 key，select 展开态由外层按 key 管理 */
  key: string
  /** 无障碍标签 / 下拉项文字 */
  label: string
  glyph?: string
  /** 图标文件路径（优先于 glyph），如关闭用 /static/icons/close.svg */
  icon?: string
  kind: ReportActionKind
  /** 是否高亮（明细表 tab / 当前图表类型） */
  active?: boolean
  /** 是否禁用 */
  disabled?: boolean
  /** 与相邻项同组 → 渲染进同一个 segmented 框 */
  group?: string
  /** select 的下拉项 */
  children?: ReportActionChild[]
  /** 点击行为（select 点击只展开，选择走 children[].run） */
  run?: () => void | Promise<void>
}

/**
 * 图表块的工具栏输入：由 ReportChart 传入业务状态，本函数产出通用操作数组。
 * 顺序与 PC 端 ChartBlock 一致：[图表类型/明细表] [下载/复制] [最大化] [关闭]。
 */
export interface ChartActionsInput {
  /** 可用图表类型（空则不提供图表/明细切换） */
  chartTypes: Array<{ key: string; label: string; glyph?: string }>
  currentView: string
  hasImage: boolean
  labels: {
    detailTable: string
    maximize: string
    close: string
    downloadImage: string
    copyImageLink: string
  }
  onSelectView: (view: string) => void
  onMaximize: () => void
  onClose: () => void
  onDownload: () => void
  onCopyLink: () => void
}

export function buildChartActions(input: ChartActionsInput): ReportAction[] {
  const actions: ReportAction[] = []

  if (input.chartTypes.length) {
    // 图表类型下拉（当前项图标 + ▾），与明细表 tab 同组（segmented 框）
    const current = input.chartTypes.find((c) => c.key === input.currentView) ?? input.chartTypes[0]
    actions.push({
      key: 'chart-type',
      label: current.label,
      glyph: current.glyph,
      kind: 'select',
      group: 'view',
      active: input.currentView !== 'table',
      children: input.chartTypes.map((c) => ({
        key: c.key,
        label: c.label,
        glyph: c.glyph,
        active: c.key === input.currentView,
        run: () => input.onSelectView(c.key),
      })),
    })
    actions.push({
      key: 'table',
      label: input.labels.detailTable,
      glyph: '▦',
      kind: 'button',
      group: 'view',
      active: input.currentView === 'table',
      run: () => input.onSelectView('table'),
    })
  }

  if (input.hasImage) {
    // 图片操作是一个下拉 tab：一个按钮（⧉ + ▾）展开「下载图片 / 复制链接」两项
    actions.push({
      key: 'image-actions',
      label: input.labels.copyImageLink,
      glyph: '⧉',
      kind: 'select',
      children: [
        {
          key: 'download-image',
          label: input.labels.downloadImage,
          glyph: '↓',
          run: input.onDownload,
        },
        {
          key: 'copy-image-link',
          label: input.labels.copyImageLink,
          glyph: '⧉',
          run: input.onCopyLink,
        },
      ],
    })
  }

  actions.push({
    key: 'maximize',
    label: input.labels.maximize,
    glyph: '⛶',
    kind: 'button',
    run: input.onMaximize,
  })
  actions.push({
    key: 'close',
    label: input.labels.close,
    icon: '/static/icons/close.svg',
    kind: 'close',
    run: input.onClose,
  })
  return actions
}
