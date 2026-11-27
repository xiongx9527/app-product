import { describe, it, expect } from 'vitest'
import type { ReportBlock } from '../../src/protocol'
import { parseReportFromToolResult } from '../../src/service/reportParser'

/** 真机 askdata__mcp_question 成功返回的结构（字段与公网实测一致）。 */
function toolResult(text: string, state = 'success'): unknown {
  return { state, content: [{ type: 'text', text }] }
}

const REAL_TEXT = JSON.stringify({
  success: true,
  record_id: 1083499990311008,
  sql: 'SELECT ...',
  data: {
    fields: ['年级名称', '班级数', '学生人数'],
    data: [
      { 年级名称: '一年级', 班级数: 4, 学生人数: 39 },
      { 年级名称: '二年级', 班级数: 5, 学生人数: 34 },
    ],
    datasource: 1,
  },
  chart: {
    type: 'column',
    title: '各年级班级数和学生人数',
    columns: [
      { name: '年级名称', value: '年级名称' },
      { name: '班级数', value: '班级数' },
    ],
  },
  image_url: '/api/chart/image/cb631f8b56c942b581051134680f0ee5',
  markdown: '| 年级名称 | 班级数 |\n![](/api/chart/image/xxx)',
})

describe('parseReportFromToolResult', () => {
  it('有数据时只下发一个 chart 块：chartType + PNG 地址都挂在块上，明细表是其内部 tab', () => {
    const r = parseReportFromToolResult(toolResult(REAL_TEXT))
    expect(r).not.toBeNull()
    expect(r!.title).toBe('各年级班级数和学生人数')
    expect(r!.blocks.map((b) => b.type)).toEqual(['chart'])
    const chart = r!.blocks.find((b) => b.type === 'chart') as Extract<ReportBlock, { type: 'chart' }>
    expect(chart.columns.map((c) => c.name)).toEqual(['年级名称', '班级数', '学生人数'])
    expect(chart.rows).toHaveLength(2)
    expect(chart.rows[0]).toEqual({ 年级名称: '一年级', 班级数: 4, 学生人数: 39 })
    expect(chart.imageUrl).toBe('/api/chart/image/cb631f8b56c942b581051134680f0ee5')
    expect(chart.chartType).toBe('column') // 后端 chart.type 决定可用图表类型（PC 端规则）
    expect(r!.blocks.some((b) => b.type === 'table' || b.type === 'image')).toBe(false) // 不再单独下发
  })

  it('只有图片（无 data）时仍只下发 image 块', () => {
    const obj = JSON.parse(REAL_TEXT)
    obj.data.fields = []
    obj.data.data = []
    const r = parseReportFromToolResult(toolResult(JSON.stringify(obj)))
    expect(r).not.toBeNull()
    expect(r!.blocks.map((b) => b.type)).toEqual(['image'])
  })

  it('工具在 JSON 前带一句说明文字仍能解析（从第一个 { 起取对象）', () => {
    const r = parseReportFromToolResult(toolResult(`查询结果如下：\n${REAL_TEXT}`))
    expect(r).not.toBeNull()
    expect(r!.blocks.map((b) => b.type)).toEqual(['chart'])
  })

  it('非问数工具（无 data/chart 形状）返回 null', () => {
    expect(parseReportFromToolResult(toolResult(JSON.stringify({ token: 'x' })))).toBeNull()
  })

  it('失败结果 success=false 返回 null', () => {
    const failed = JSON.stringify({ success: false, message: '未按照指定前缀提交 token' })
    expect(parseReportFromToolResult(toolResult(failed))).toBeNull()
  })

  it('脏 JSON / 非对象 content 返回 null，不抛错', () => {
    expect(parseReportFromToolResult(toolResult('not json'))).toBeNull()
    expect(parseReportFromToolResult({ state: 'success', content: [] })).toBeNull()
    expect(parseReportFromToolResult(null)).toBeNull()
  })

  it('后端 chart.type=table 时仍只下发 chart 块（明细表 tab），chartType 如实下发', () => {
    const obj = JSON.parse(REAL_TEXT)
    delete obj.image_url
    obj.chart.type = 'table'
    const r = parseReportFromToolResult(toolResult(JSON.stringify(obj)))
    expect(r).not.toBeNull()
    expect(r!.blocks.map((b) => b.type)).toEqual(['chart'])
    const chart = r!.blocks.find((b) => b.type === 'chart') as Extract<ReportBlock, { type: 'chart' }>
    expect(chart.imageUrl).toBeUndefined()
    expect(chart.chartType).toBe('table')
  })

  it('空 fields 且无 image_url 无法组成任何块 → null', () => {
    const obj = JSON.parse(REAL_TEXT)
    obj.data.fields = []
    delete obj.image_url
    expect(parseReportFromToolResult(toolResult(JSON.stringify(obj)))).toBeNull()
  })
})
