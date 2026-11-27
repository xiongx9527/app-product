<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '@/core/i18n'
import type { ReportBlock } from '@/core/transport/types'
import { isNumericColumn, sortRows, type SortDir } from '../chartModel'

/**
 * 表格块渲染器：本地铺一张表，列元数据 columns + 行数据 rows 分离（借鉴 SQLBot 前端 data/chart 契约）。
 * 组件不认识任何具体列名，纯按 columns[].value 从 row 取值；横向可滚动、数字右对齐。
 * 列头点击切三态排序（none→desc→asc），与 java-product Table.ts 的智能排序一致；样式为
 * 浅蓝表头 + 清晰网格边框（截图参照），比旧的半透明暗底更醒目。
 * 与商品详情体系无关，只依赖协议层 table 块。
 */
type TableBlock = Extract<ReportBlock, { type: 'table' }>
const props = defineProps<{ block: TableBlock }>()

const columns = computed(() => props.block.columns ?? [])
/** 每列宽度按列数平分占满容器；表头与数据行用同一宽度，严格对齐不错位。 */
const colWidth = computed(() => (columns.value.length ? `${100 / columns.value.length}%` : '100%'))
const sortKey = ref('')
const sortDir = ref<SortDir>('none')

/** 三态循环：none → desc → asc → none。 */
function cycleSort(key: string): void {
  if (sortKey.value !== key) {
    sortKey.value = key
    sortDir.value = 'desc'
    return
  }
  sortDir.value = sortDir.value === 'none' ? 'desc' : sortDir.value === 'desc' ? 'asc' : 'none'
}

function arrowFor(key: string): string {
  if (sortKey.value !== key || sortDir.value === 'none') return '▾'
  return sortDir.value === 'asc' ? '▲' : '▼'
}

const rows = computed(() =>
  sortKey.value && sortDir.value !== 'none'
    ? sortRows(props.block.rows ?? [], sortKey.value, sortDir.value)
    : (props.block.rows ?? []),
)

/** 数字列（或值全为数字的列）右对齐，看着像正经报表。 */
function numericCol(value: string): boolean {
  return isNumericColumn(props.block.rows ?? [], value)
}
</script>

<template>
  <scroll-view v-if="columns.length && rows.length" scroll-x class="report-table-scroll">
    <view class="report-table">
      <view class="report-tr report-tr--head">
        <view
          v-for="c in columns"
          :key="c.value"
          class="report-cell report-th"
          :class="{ 'report-cell--num': numericCol(c.value) }"
          :style="{ width: colWidth }"
          @tap="cycleSort(c.value)"
        >
          <text class="th-name">{{ c.name }}</text>
          <text class="th-arrow" :class="{ active: sortKey === c.value && sortDir !== 'none' }">{{ arrowFor(c.value) }}</text>
        </view>
      </view>
      <view v-for="(row, ri) in rows" :key="ri" class="report-tr" :class="{ 'report-tr--alt': ri % 2 === 1 }">
        <view
          v-for="c in columns"
          :key="c.value"
          class="report-cell report-td"
          :class="{ 'report-cell--num': numericCol(c.value) }"
          :style="{ width: colWidth }"
        >
          <text>{{ row[c.value] ?? '' }}</text>
        </view>
      </view>
    </view>
  </scroll-view>
  <text v-else class="report-empty">{{ t('report.empty') }}</text>
</template>

<style scoped>
.report-table-scroll {
  width: 100%;
}
.report-table {
  display: flex;
  flex-direction: column;
  min-width: 100%;
  border: 1px solid rgba(120, 160, 255, 0.35);
  border-radius: 6px;
  overflow: hidden;
}
.report-tr {
  display: flex;
  flex-direction: row;
  border-bottom: 1px solid rgba(120, 160, 255, 0.25);
}
.report-tr:last-child {
  border-bottom: none;
}
.report-tr--head {
  border-bottom: 1px solid rgba(120, 160, 255, 0.5);
}
.report-tr--alt {
  background: rgba(120, 160, 255, 0.06);
}
.report-cell {
  flex-shrink: 0;
  box-sizing: border-box;
  padding: 8px 10px;
  font-size: 12px;
  white-space: nowrap;
  border-right: 1px solid rgba(120, 160, 255, 0.25);
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  overflow: hidden;
}
.report-th:last-child,
.report-td:last-child {
  border-right: none;
}
.report-th {
  background: #dce8ff;
  color: #1b3a6b;
  font-weight: 600;
  justify-content: flex-start;
}
.th-name {
  flex: 1;
}
.th-arrow {
  font-size: 9px;
  color: #7a93bd;
}
.th-arrow.active {
  color: #1b6fe4;
}
.report-td {
  color: #2a3350;
  background: rgba(255, 255, 255, 0.92);
}
.report-tr--alt .report-td {
  background: #f0f5ff;
}
.report-cell--num {
  justify-content: flex-end;
  text-align: right;
}
.report-empty {
  font-size: 12px;
  color: #8b91ab;
}
</style>
