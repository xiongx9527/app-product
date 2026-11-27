/**
 * 报表图表的纯数据模型（不 import 任何 .vue，便于 node 环境单测）。
 *
 * 参照 java-product（SQLBot 类）前端的 chart 契约：columns 列元数据 + data 行数据分离，
 * axis 分 x（分类）/ y（数值系列）。这里不依赖后端下发的 chart.axis，直接从 table 数据
 * 推断：第一列作 x 分类轴，其余全数值列作 y 系列（支持多系列），与 java-product 的
 * x/y/series 语义一致。
 */

export interface ChartColumn {
  name: string
  value: string
}

export type ChartRow = Record<string, string | number>

export type ChartType = 'column' | 'bar' | 'line'

export type SortDir = 'none' | 'desc' | 'asc'

export interface ChartAxes {
  /** x 轴（分类）列名 */
  xKey: string
  /** y 轴（数值系列）列名，可多个 */
  yKeys: string[]
}

/** 单元格值是否为数字（含带千分位/小数/负数的字符串）。 */
export function isNumericValue(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'string') return v.trim() !== '' && /^-?\d[\d,]*\.?\d*$/.test(v.trim())
  return false
}

/** 某列是否全为数值（空值跳过；无有效值不算数值列）。 */
export function isNumericColumn(rows: ChartRow[], key: string): boolean {
  const vals = rows.map((r) => r[key]).filter((v) => v !== '' && v != null)
  if (!vals.length) return false
  return vals.every(isNumericValue)
}

/**
 * 从 columns + rows 推断 x/y 轴：
 * - 第一列恒作 x（分类轴），即使它也是数值（如序号/年份）；
 * - 其余列中「全数值」的作 y 系列；非数值列忽略（图表画不了）。
 */
export function inferAxes(columns: ChartColumn[], rows: ChartRow[]): ChartAxes | null {
  if (!columns.length || !rows.length) return null
  const xKey = columns[0].value
  const yKeys = columns.slice(1).map((c) => c.value).filter((key) => isNumericColumn(rows, key))
  if (!yKeys.length) return null
  return { xKey, yKeys }
}

/**
 * 可用图表类型：严格按 PC 端 ChartBlock 的 chartTypeList 规则——
 * 后端 chart.type 为 column/bar/line 时下拉提供这三种；table 不提供（只有明细表 tab）；
 * pie 本端不支持绘制，也回退为不提供（只显示明细表）。无数据一律不提供。
 */
export function chartTypesFor(
  columns: ChartColumn[],
  rows: ChartRow[],
  chartType?: string,
): ChartType[] {
  if (!inferAxes(columns, rows)) return []
  if (chartType === 'column' || chartType === 'bar' || chartType === 'line') {
    return ['column', 'bar', 'line']
  }
  return []
}

/**
 * 数量轴刻度上限（对齐 PC 端的 scale.y.nice）：把真实最大值向上取整到整洁刻度，
 * 如 4→5、39→40、123→150、7→10。返回 { max, step }——max 是轴顶，step 是每格步长。
 */
export function niceScale(rawMax: number): { max: number; step: number } {
  if (!Number.isFinite(rawMax) || rawMax <= 0) return { max: 4, step: 1 }
  // 轴顶取真实最大值的整数上界（不强行放大到 5/10 量级，避免把 6 画成 10），
  // 再按 4 格取整步长，保证刻度是 0/2/4/6 这类整数（对齐 PC 端 G2 的 nice 刻度）。
  // 轴顶必须严格大于数据最大值（柱子不贴顶），在此前提下取 4 格整洁刻度
  const target = (rawMax + 0.0001) / 4
  let step = 1
  while (step < target) {
    if (step * 5 <= target) step *= 10
    else if (step * 2 <= target) step *= 5
    else step *= 2
  }
  if (step * 4 <= rawMax) step *= 2 // 轴顶恰好等于最大值时再升一档，留余量
  return { max: step * 4, step }
}

/** 取单元格数值（去千分位）；非数字返回 0。 */
function toNumber(v: string | number | undefined): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, '').trim())
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/** 三态排序：none 原序、desc 降序、asc 升序；不改原数组（返回新数组）。 */
export function sortRows(rows: ChartRow[], key: string, dir: SortDir): ChartRow[] {
  if (dir === 'none') return rows.slice()
  const numeric = isNumericColumn(rows, key)
  return rows.slice().sort((a, b) => {
    const va = a[key]
    const vb = b[key]
    // 空值恒排末尾
    if (va === '' || va == null) return 1
    if (vb === '' || vb == null) return -1
    let cmp: number
    if (numeric) cmp = toNumber(va) - toNumber(vb)
    else {
      // 中文按拼音序（Intl.Collator 在 node 与 uni-app 均可用），英文/数字退化为普通比较
      try {
        cmp = new Intl.Collator('zh-CN').compare(String(va), String(vb))
      } catch {
        cmp = String(va).localeCompare(String(vb))
      }
    }
    return dir === 'asc' ? cmp : -cmp
  })
}
