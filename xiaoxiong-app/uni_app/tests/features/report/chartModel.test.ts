import { describe, expect, it } from 'vitest'
import {
  chartTypesFor,
  inferAxes,
  isNumericColumn,
  isNumericValue,
  niceScale,
  sortRows,
  type ChartColumn,
  type ChartRow,
} from '../../../src/features/report/chartModel'

const columns: ChartColumn[] = [
  { name: '年级名称', value: '年级名称' },
  { name: '班级数', value: '班级数' },
  { name: '学生人数', value: '学生人数' },
]
const rows: ChartRow[] = [
  { 年级名称: '一年级', 班级数: 4, 学生人数: 39 },
  { 年级名称: '三年级', 班级数: 4, 学生人数: 40 },
  { 年级名称: '二年级', 班级数: 5, 学生人数: 34 },
]

describe('report chartModel', () => {
  it('isNumericValue：数字与带千分位/负数/小数字符串算数值，空串/文本不算', () => {
    expect(isNumericValue(4)).toBe(true)
    expect(isNumericValue('1,234')).toBe(true)
    expect(isNumericValue('-3.5')).toBe(true)
    expect(isNumericValue('')).toBe(false)
    expect(isNumericValue('一年级')).toBe(false)
  })

  it('isNumericColumn：全数值列才成立，含文本不算', () => {
    expect(isNumericColumn(rows, '班级数')).toBe(true)
    expect(isNumericColumn(rows, '年级名称')).toBe(false)
  })

  it('inferAxes：第一列作 x，其余数值列作 y 系列（支持多系列）', () => {
    expect(inferAxes(columns, rows)).toEqual({ xKey: '年级名称', yKeys: ['班级数', '学生人数'] })
  })

  it('inferAxes：无非数值 y 列时返回 null（画不了图）', () => {
    const textRows: ChartRow[] = [{ A: 'x', B: 'y' }, { A: 'z', B: 'w' }]
    expect(inferAxes([{ name: 'A', value: 'A' }, { name: 'B', value: 'B' }], textRows)).toBeNull()
  })

  it('chartTypesFor：严格按后端 chart.type 决定（PC 端规则），无数据返回空', () => {
    expect(chartTypesFor(columns, rows, 'column')).toEqual(['column', 'bar', 'line'])
    expect(chartTypesFor(columns, rows, 'bar')).toEqual(['column', 'bar', 'line'])
    expect(chartTypesFor(columns, rows, 'line')).toEqual(['column', 'bar', 'line'])
    expect(chartTypesFor(columns, rows, 'table')).toEqual([])
    expect(chartTypesFor(columns, rows, 'pie')).toEqual([])
    expect(chartTypesFor(columns, [], 'column')).toEqual([])
  })

  it('niceScale：数量轴向上取整到整洁刻度（PC 端 scale.y.nice）', () => {
    expect(niceScale(4)).toEqual({ max: 8, step: 2 }) // 0/2/4/6/8（轴顶严格大于数据最大值）
    expect(niceScale(6)).toEqual({ max: 8, step: 2 })
    expect(niceScale(39)).toEqual({ max: 40, step: 10 }) // 0/10/20/30/40
    expect(niceScale(0)).toEqual({ max: 4, step: 1 })
  })

  it('sortRows：数字列 asc/desc 按数值排，文本列按 localeCompare，none 原序', () => {
    expect(sortRows(rows, '班级数', 'asc').map((r) => r['年级名称'])).toEqual(['一年级', '三年级', '二年级'])
    expect(sortRows(rows, '班级数', 'desc').map((r) => r['班级数'])).toEqual([5, 4, 4])
    expect(sortRows(rows, '班级数', 'none').map((r) => r['年级名称'])).toEqual(['一年级', '三年级', '二年级'])
    // 文本列按拼音序（Intl.Collator zh-CN）：二(er) < 三(san) < 一(yi)
    expect(sortRows(rows, '年级名称', 'asc').map((r) => r['年级名称'])).toEqual(['二年级', '三年级', '一年级'])
  })

  it('sortRows：不改原数组，空值排末尾', () => {
    const withEmpty: ChartRow[] = [{ n: 2 }, { n: '' }, { n: 1 }]
    const sorted = sortRows(withEmpty, 'n', 'asc')
    expect(sorted.map((r) => r['n'])).toEqual([1, 2, ''])
    expect(withEmpty[0]['n']).toBe(2) // 原数组未变
  })
})
