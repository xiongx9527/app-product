import { describe, expect, it, vi } from 'vitest'
import { buildChartActions, type ChartActionsInput } from '../../../src/features/report/reportActions'

function makeInput(patch: Partial<ChartActionsInput> = {}): ChartActionsInput {
  return {
    chartTypes: [
      { key: 'column', label: '柱状图', glyph: '▥' },
      { key: 'bar', label: '条形图', glyph: '▤' },
      { key: 'line', label: '折线图', glyph: '╱' },
    ],
    currentView: 'column',
    hasImage: true,
    labels: {
      detailTable: '明细表', maximize: '最大化', close: '关闭报表',
      downloadImage: '下载图片', copyImageLink: '复制链接',
    },
    onSelectView: vi.fn(), onMaximize: vi.fn(), onClose: vi.fn(), onDownload: vi.fn(), onCopyLink: vi.fn(),
    ...patch,
  }
}

describe('reportActions.buildChartActions', () => {
  it('有数据+图片时：类型下拉/明细表同组，图片操作是一个下拉 tab（含下载/复制两项），最大化+关闭', () => {
    const a = buildChartActions(makeInput())
    expect(a.map((x) => x.key)).toEqual(['chart-type', 'table', 'image-actions', 'maximize', 'close'])
    expect(a[0].kind).toBe('select')
    expect(a[0].group).toBe('view')
    expect(a[0].children).toHaveLength(3)
    expect(a[1].group).toBe('view')
    expect(a[2].kind).toBe('select')
    expect(a[2].children!.map((c) => c.key)).toEqual(['download-image', 'copy-image-link'])
    expect(a[4].kind).toBe('close')
  })

  it('无图片时不出下载/复制；无图表类型时不出类型下拉/明细表', () => {
    const noImg = buildChartActions(makeInput({ hasImage: false }))
    expect(noImg.map((x) => x.key)).not.toContain('image-actions')
    const noChart = buildChartActions(makeInput({ chartTypes: [], currentView: 'table' }))
    // 无图表类型时不出类型下拉/明细表；有图片则图片操作下拉仍在
    expect(noChart.map((x) => x.key)).toEqual(['image-actions', 'maximize', 'close'])
    const minimal = buildChartActions(makeInput({ chartTypes: [], currentView: 'table', hasImage: false }))
    expect(minimal.map((x) => x.key)).toEqual(['maximize', 'close'])
  })

  it('明细表选中时高亮正确，类型下拉用当前项图标', () => {
    const a = buildChartActions(makeInput({ currentView: 'table' }))
    expect(a[0].active).toBe(false) // 图表类型未选中
    expect(a[1].active).toBe(true)  // 明细表选中
    const b = buildChartActions(makeInput({ currentView: 'line' }))
    expect(b[0].glyph).toBe('╱')
    expect(b[0].children!.find((c) => c.key === 'line')!.active).toBe(true)
  })

  it('回调正确绑定：选择视图/下载/复制/最大化/关闭', () => {
    const input = makeInput()
    const a = buildChartActions(input)
    a[0].children![1].run!() // 选 bar
    a[2].children![0].run!() // 下载
    a[2].children![1].run!() // 复制
    a[3].run!() // 最大化
    a[4].run!() // 关闭
    expect(input.onSelectView).toHaveBeenCalledWith('bar')
    expect(input.onDownload).toHaveBeenCalledTimes(1)
    expect(input.onCopyLink).toHaveBeenCalledTimes(1)
    expect(input.onMaximize).toHaveBeenCalledTimes(1)
    expect(input.onClose).toHaveBeenCalledTimes(1)
  })
})
