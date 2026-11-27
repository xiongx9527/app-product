/**
 * 从 MCP 问数工具的结构化结果里提取「报表展示区」载荷（media.report）。
 *
 * 这是网关 → App 报表通道的数据映射层：
 *   LLM 工具调用结果（askdata__mcp_question 等）里带 data.fields/data.data/image_url/chart，
 *   但 LLM 只会把它复述成口播文字、不会原文输出到界面，导致「说了已显示、屏幕却没有」。
 *   这里在工具结果处把结构化数据搬运成统一的 ReportPayload，经 onReport 下发给 App 本地渲染。
 *
 * 设计约束（与商品详情 media.detail 体系完全独立）：
 * - 纯函数、不抛错：任何非问数工具 / 脏数据 / 缺字段都返回 null，绝不影响原工具返回给 LLM。
 * - 只做数据搬运，绝不编造：列名取 data.fields、行取 data.data、图片取 image_url、标题取 chart.title。
 * - 按结果「形状」识别，与工具名解耦：结果 JSON 同时带 success + data + (chart|image_url|markdown)
 *   即视为问数结果；换数据源/换工具名只要仍满足该形状就能被识别。
 */

import type { ReportBlock, ReportPayload } from '../protocol'

/** 一行单元格值：JSON 里可能是数字/字符串/null，统一收敛成可展示的 string|number。 */
type CellValue = string | number

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 从工具结果的 content[].text 里取出第一段可解析的 JSON 对象。 */
function parseResultObject(last: unknown): Record<string, unknown> | null {
  if (!isRecord(last)) return null
  const content = last.content
  if (!Array.isArray(content)) return null
  for (const c of content) {
    if (!isRecord(c) || typeof c.text !== 'string') continue
    const text = (c.text as string).trim()
    // 工具可能在 JSON 前带一句说明（如「查询结果：{...}」），从第一个 { 起解析；
    // 纯文本 / 无对象块则跳过，继续找下一个 content 块，不因一块脏数据放弃。
    const start = text.indexOf('{')
    if (start < 0) continue
    try {
      const obj = JSON.parse(text.slice(start))
      if (isRecord(obj)) return obj
    } catch {
      // 继续找下一个 content 块
    }
  }
  return null
}

/** 判断是不是问数结果：成功标志 + data 结构 + (chart 或 image_url 任一)。 */
function looksLikeQuestionResult(obj: Record<string, unknown>): boolean {
  if (obj.success !== true) return false
  if (!isRecord(obj.data)) return false
  return 'chart' in obj || 'image_url' in obj || 'markdown' in obj
}

/** 从 data.fields + data.data 提取列元数据与行数据；列缺失或无行时返回 null。 */
function extractTableData(data: Record<string, unknown>): {
  columns: Array<{ name: string; value: string }>
  rows: Array<Record<string, CellValue>>
} | null {
  const fields = Array.isArray(data.fields) ? data.fields.filter((f): f is string => typeof f === 'string') : []
  const rawRows = Array.isArray(data.data) ? data.data : []
  if (!fields.length || !rawRows.length) return null
  const columns = fields.map((name) => ({ name, value: name }))
  const rows: Array<Record<string, CellValue>> = []
  for (const r of rawRows) {
    if (!isRecord(r)) continue
    const row: Record<string, CellValue> = {}
    for (const key of fields) {
      const v = r[key]
      if (typeof v === 'number' || typeof v === 'string') row[key] = v
      else if (v == null) row[key] = ''
      else row[key] = String(v)
    }
    rows.push(row)
  }
  if (!rows.length) return null
  return { columns, rows }
}

/** 取 image_url（相对路径原样下发，客户端按服务地址拼绝对）；无有效地址返回 null。 */
function extractImageUrl(obj: Record<string, unknown>): string | null {
  const url = obj.image_url
  if (typeof url !== 'string' || !url.trim()) return null
  return url.trim()
}

/** 报表标题：优先 chart.title，其次 data 里没有则留空（客户端有 i18n 兜底）。 */
function buildTitle(obj: Record<string, unknown>): string {
  const chart = obj.chart
  if (isRecord(chart) && typeof chart.title === 'string' && chart.title.trim()) return chart.title.trim()
  return ''
}

/** 后端 chart.type（column/bar/line/table/pie）：按 PC 端 chartTypeList 规则决定可用类型。 */
function extractChartType(obj: Record<string, unknown>): string | undefined {
  const chart = obj.chart
  if (isRecord(chart) && typeof chart.type === 'string' && chart.type.trim()) return chart.type.trim()
  return undefined
}

/**
 * 解析工具结果为报表载荷：只按结果形状判断（success + data + chart/image_url/markdown），
 * 不依赖工具名——换数据源/换工具名只要形状一致就能识别。解析不出任何块则仍返回 null。
 * 非问数工具、access_token、失败结果、脏 JSON 一律返回 null。
 */
export function parseReportFromToolResult(last: unknown): ReportPayload | null {
  const obj = parseResultObject(last)
  if (!obj || !looksLikeQuestionResult(obj)) return null

  const blocks: ReportBlock[] = []
  const data = obj.data as Record<string, unknown>
  const tableData = extractTableData(data)
  const imageUrl = extractImageUrl(obj)
  if (tableData) {
    // 【2026-11-26】有数据时只下发一个 chart 块：图表 / 明细表是它内部的 2 个 tab，
    // 不能再单独下发 table 块——否则 ReportBlocks 会把两块都渲染出来，出现两个明细表。
    // 后端 chart.type + PNG 地址挂在块上，工具栏据此决定可用类型与「下载/复制链接」。
    blocks.push({
      type: 'chart',
      columns: tableData.columns,
      rows: tableData.rows,
      chartType: extractChartType(obj),
      imageUrl: imageUrl ?? undefined,
    })
  } else if (imageUrl) {
    // 只有图片（无可绘制数据）：ImageBlock 成为唯一展示块，客户端直接渲染 PNG。
    blocks.push({ type: 'image', url: imageUrl })
  }
  if (!blocks.length) return null

  return { title: buildTitle(obj), blocks }
}
