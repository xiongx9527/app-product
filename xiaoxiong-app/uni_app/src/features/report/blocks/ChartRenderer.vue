<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from 'vue'
import { t } from '@/core/i18n'
import type { ReportBlock } from '@/core/transport/types'
import { inferAxes, niceScale, type ChartType, type ChartRow } from '../chartModel'
import ReportTable from './ReportTable.vue'

/**
 * 报表图表的纯渲染区：按 viewType 在同一份数据上画柱状图/条形图/折线图或明细表。
 * 柱状/条形用 view+CSS；折线用 canvas（uni.createCanvasContext）精确绘制——纯 view+CSS
 * 的旋转线段混用了 x/y 两套百分比坐标系，角度算错会乱，canvas 用统一像素坐标最稳。
 * App/H5 通吃；canvas 只在图表卡内，不与悬浮球层级冲突。
 */
type ChartBlock = Extract<ReportBlock, { type: 'chart' }>
const props = withDefaults(
  defineProps<{
    block: ChartBlock
    viewType: ChartType | 'table'
    /** canvas-id，最大化与普通视图各用一个避免冲突 */
    canvasId?: string
    /** 最大化：图表撑满容器高度 */
    expanded?: boolean
  }>(),
  { canvasId: 'report-line', expanded: false },
)

const axes = computed(() => inferAxes(props.block.columns, props.block.rows))
const xKey = computed(() => axes.value?.xKey ?? '')
const yKeys = computed(() => axes.value?.yKeys ?? [])
const rows = computed<ChartRow[]>(() => props.block.rows ?? [])

function seriesName(key: string): string {
  return props.block.columns.find((c) => c.value === key)?.name ?? key
}

/** 真实数据最大值 */
const rawMax = computed(() => {
  let max = 0
  for (const key of yKeys.value) {
    for (const r of rows.value) {
      const n = Number(String(r[key] ?? '').replace(/,/g, ''))
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return max
})
/** 数量轴（PC 端 scale.y.nice）：轴顶与 4 格刻度 */
const scale = computed(() => niceScale(rawMax.value))
const maxValue = computed(() => scale.value.max)
/** Y 轴刻度值，从顶到底：如轴顶8/step2 → [8,6,4,2,0] */
const yTicks = computed(() => {
  const out: number[] = []
  for (let v = scale.value.max; v >= 0; v -= scale.value.step) out.push(v)
  return out
})

function pct(key: string, row: ChartRow): string {
  const n = Number(String(row[key] ?? '').replace(/,/g, ''))
  const v = Number.isFinite(n) ? Math.max(0, n) / maxValue.value : 0
  return `${Math.max(2, Math.min(100, v * 100)).toFixed(2)}%`
}

/** 柱顶数值：数字加千分位逗号还原、去掉多余小数尾零；非数字原样显示。 */
function formatValue(v: unknown): string {
  const s = String(v ?? '')
  const n = Number(s.replace(/,/g, ''))
  if (!Number.isFinite(n)) return s
  return String(Number(n.toFixed(2)))
}

const tableBlock = computed<Extract<ReportBlock, { type: 'table' }>>(() => ({
  type: 'table',
  columns: props.block.columns,
  rows: props.block.rows,
}))

/** canvas 折线：统一像素坐标绘制网格、多系列折线、数据点、x 分类标签。 */
const COLORS = ['#4f8cff', '#9be8cd', '#ffb454', '#ff6b9d']

/** 取 canvas 实际渲染尺寸（样式 width/height:100%），避免写死逻辑尺寸导致画不满/留白。 */
function canvasSize(): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    // #ifdef APP-PLUS || H5
    uni.createSelectorQuery()
      .select(`#${props.canvasId}`)
      .boundingClientRect((rect: any) => resolve({
        w: rect?.width ? Math.round(rect.width) : 320,
        h: rect?.height ? Math.round(rect.height) : (props.expanded ? 480 : 170),
      }))
      .exec()
    // #endif
    // #ifndef APP-PLUS || H5
    resolve({ w: 320, h: props.expanded ? 480 : 170 })
    // #endif
  })
}

async function drawLine(): Promise<void> {
  if (props.viewType !== 'line' || !rows.value.length || !yKeys.value.length) return
  // #ifdef APP-PLUS || H5
  const { w: W, h: H } = await canvasSize() // 按实际尺寸绘制，折线占满容器
  const ctx = uni.createCanvasContext(props.canvasId)
  const padL = 28
  const padR = 10
  const padT = 12
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const n = rows.value.length

  ctx.clearRect(0, 0, W, H)
  // Y 轴数量刻度（PC 端 scale.y.nice）：每格一条横线 + 刻度值
  ctx.setFillStyle('#8b91ab')
  ctx.setFontSize(9)
  const ticks = yTicks.value
  ticks.forEach((tick, i) => {
    const y = padT + (plotH * i) / (ticks.length - 1)
    ctx.setStrokeStyle('rgba(255,255,255,0.12)')
    ctx.setLineWidth(1)
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(W - padR, y)
    ctx.stroke()
    ctx.setFillStyle('#8b91ab')
    ctx.fillText(String(tick), 2, y + 3)
  })

  const xAt = (i: number): number => (n <= 1 ? padL + plotW / 2 : padL + (plotW * i) / (n - 1))
  const yAt = (v: number): number => padT + plotH - (Math.max(0, v) / maxValue.value) * plotH

  yKeys.value.forEach((key, si) => {
    const color = COLORS[si % COLORS.length]
    ctx.setStrokeStyle(color)
    ctx.setLineWidth(2)
    ctx.beginPath()
    rows.value.forEach((r, i) => {
      const raw = Number(String(r[key] ?? '').replace(/,/g, ''))
      const v = Number.isFinite(raw) ? raw : 0
      const x = xAt(i)
      const y = yAt(v)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
    // 数据点
    ctx.setFillStyle('#fff')
    rows.value.forEach((r, i) => {
      const raw = Number(String(r[key] ?? '').replace(/,/g, ''))
      const v = Number.isFinite(raw) ? raw : 0
      const x = xAt(i)
      const y = yAt(v)
      ctx.beginPath()
      ctx.arc(x, y, 3, 0, 2 * Math.PI)
      ctx.fill()
      ctx.setStrokeStyle(color)
      ctx.setLineWidth(1.5)
      ctx.stroke()
    })
  })

  // x 分类标签（过多时隔行显示）
  ctx.setFillStyle('#8b91ab')
  ctx.setFontSize(9)
  const step = n > 8 ? Math.ceil(n / 8) : 1
  rows.value.forEach((r, i) => {
    if (i % step !== 0 && i !== n - 1) return
    const label = String(r[xKey.value] ?? '')
    const short = label.length > 5 ? `${label.slice(0, 4)}…` : label
    // 按字数估算标签宽度并居中；clamp 到 canvas 内，避免最后一个分类（如"六年级"）
    // 因固定 -12 偏移超出右边界被裁掉。
    const textW = Array.from(short).length * 9
    let tx = xAt(i) - textW / 2
    tx = Math.max(0, Math.min(tx, W - textW))
    ctx.fillText(short, tx, H - 8)
  })

  ctx.draw()
  // #endif
}

function redraw(): void {
  if (props.viewType === 'line') nextTick(drawLine)
}
onMounted(redraw)
watch(() => [props.viewType, props.block] as const, redraw, { deep: true })
</script>

<template>
  <view class="chart-renderer" :class="{ 'is-expanded': expanded }">
    <ReportTable v-if="viewType === 'table'" :block="tableBlock" />
    <text v-else-if="!axes || !rows.length" class="chart-empty">{{ t('report.empty') }}</text>

    <view v-else-if="viewType === 'column'" class="chart-column">
      <view class="chart-with-axis">
        <!-- Y 轴数量刻度（PC 端 scale.y.nice）：顶→底 -->
        <view class="y-axis">
          <text v-for="(tick, ti) in yTicks" :key="ti" class="y-tick">{{ tick }}</text>
        </view>
        <view class="column-plot">
          <view v-for="(row, ri) in rows" :key="ri" class="column-group">
            <view class="column-bars">
              <view v-for="key in yKeys" :key="key" class="column-bar-wrap">
                <!-- 柱顶数值：图例只说「平均分/最高分...」是哪项，具体数字标在柱子上才看得见 -->
                <text class="bar-value">{{ formatValue(row[key]) }}</text>
                <view class="column-bar" :style="{ height: pct(key, row) }" />
              </view>
            </view>
            <text class="column-label">{{ row[xKey] }}</text>
          </view>
        </view>
      </view>
    </view>

    <view v-else-if="viewType === 'bar'" class="chart-bar">
      <view v-for="(row, ri) in rows" :key="ri" class="bar-row">
        <text class="bar-label">{{ row[xKey] }}</text>
        <view class="bar-track">
          <view v-for="key in yKeys" :key="key" class="bar-fill" :style="{ width: pct(key, row) }" />
        </view>
      </view>
      <!-- 条形图数量轴：0 → max -->
      <view class="bar-axis">
        <text v-for="(tick, ti) in [...yTicks].reverse()" :key="ti" class="bar-axis-tick">{{ tick }}</text>
      </view>
    </view>

    <view v-else-if="viewType === 'line'" class="chart-line">
      <canvas :id="canvasId" :canvas-id="canvasId" class="line-canvas" />
    </view>

    <view v-if="viewType !== 'table' && yKeys.length > 1" class="chart-legend">
      <text v-for="key in yKeys" :key="key" class="legend-item">{{ seriesName(key) }}</text>
    </view>
  </view>
</template>

<style scoped>
.chart-renderer { width: 100%; }
/* 最大化：根节点撑满，图表高度按可用空间放大 */
.chart-renderer.is-expanded { height: 100%; display: flex; flex-direction: column; }
.is-expanded .chart-column,
.is-expanded .chart-bar,
.is-expanded .chart-line { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.is-expanded .chart-with-axis { flex: 1; min-height: 0; }
.is-expanded .y-axis,
.is-expanded .column-plot { height: 100%; }
.is-expanded .column-bars { height: 100%; }
.is-expanded .line-canvas { height: 100%; min-height: 300px; }
/* 条形图最大化：行等高铺满、条加粗、数值显示 */
.is-expanded .chart-bar { justify-content: space-around; }
.is-expanded .bar-row { flex: 1; min-height: 0; }
.is-expanded .bar-fill { height: 60%; min-height: 16px; }
.chart-empty { font-size: 12px; color: #8b91ab; }
.chart-gridline { border-bottom: 1px solid rgba(255, 255, 255, 0.12); }
.chart-column { width: 100%; }
.chart-with-axis { display: flex; flex-direction: row; width: 100%; }
.y-axis {
  display: flex; flex-direction: column; justify-content: space-between;
  width: 28px; height: 155px; padding-bottom: 0; flex-shrink: 0;
}
.y-tick { font-size: 9px; color: #8b91ab; text-align: right; line-height: 1; }
.column-plot {
  display: flex; flex-direction: row; align-items: flex-end; height: 155px; gap: 6px;
  flex: 1; min-width: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.16);
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}
.column-group { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.column-bars { display: flex; flex-direction: row; align-items: flex-end; justify-content: center; gap: 2px; height: 100%; width: 100%; }
.column-bar-wrap { flex: 1; height: 100%; display: flex; align-items: flex-end; justify-content: center; min-width: 0; }
.column-bar { position: relative; flex: 1; max-width: 22px; background: linear-gradient(180deg, #4f8cff 0%, #2f6fe4 100%); border-radius: 4px 4px 0 0; min-height: 2px; }
/* 柱顶数值：贴在柱子上沿正上方，字号小避免多系列拥挤 */
.bar-value { position: absolute; top: -13px; left: 50%; transform: translateX(-50%); font-size: 8px; color: #c7cde6; white-space: nowrap; }
.column-label { font-size: 10px; color: #b9bed6; margin-top: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.chart-bar { display: flex; flex-direction: column; gap: 8px; }
.bar-row { display: flex; flex-direction: row; align-items: center; gap: 8px; }
.bar-label { width: 60px; font-size: 10px; color: #b9bed6; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-track { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bar-fill { height: 10px; background: linear-gradient(90deg, #4f8cff 0%, #2f6fe4 100%); border-radius: 0 4px 4px 0; min-width: 2px; }
.bar-axis { display: flex; flex-direction: row; justify-content: space-between; margin-left: 68px; margin-top: 4px; }
.bar-axis-tick { font-size: 9px; color: #8b91ab; }
.chart-line { width: 100%; }
.line-canvas { width: 100%; height: 170px; }
.chart-legend { display: flex; flex-direction: row; flex-wrap: wrap; gap: 12px; margin-top: 10px; }
.legend-item { font-size: 11px; color: #9be8cd; }
</style>
