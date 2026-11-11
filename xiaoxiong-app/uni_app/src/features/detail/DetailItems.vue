<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/core/i18n'
import type { DetailItem, MediaDetail } from '@/core/transport/types'

/**
 * 通用内容渲染器：编号列表 ↔ 选中详情，用同一块区域切换。
 * 只依赖协议层 DetailItem（统一字段契约），**不 import 任何数据源类型、不判断 kind**：
 * 商品（deals）与开源项目（project）等所有类型共用这一个组件。
 * 固定槽位只有 index/title/image/imageLarge/link，其余属性一律走 fields[]：换数据源、加字段、
 * 新源字段多少不一都不改本组件——缺字段不显示、无图不占位、无链接不阻断，不崩不白屏。
 */
const props = defineProps<{ detail: MediaDetail }>()
const emit = defineEmits<{ select: [index: number] }>()

/** selectedIndex 对应 DetailItem.index（1 起）；无 / null 表示列表形态。 */
const selected = computed<DetailItem | null>(() => {
  const i = props.detail.selectedIndex
  if (i === undefined || i === null) return null
  return props.detail.items.find((it) => it.index === i) ?? null
})

/** 整份列表一张图都没有时（如开源项目）不渲染缩略图列，避免每项挂个空方块。
 *  按数据判断而非按 kind，换数据源/新类型都不用改这里。 */
const anyImage = computed(() => props.detail.items.some((it) => !!it.image))

/** 列表摘要只做预览：过长会把每项撑成三四行、一屏放不下几条。
 *  统一取前两条 fields[].value 并截断，完整内容留在详情里看——列表只负责让用户选号。 */
const SUMMARY_VALUE_CAP = 20
const SUMMARY_CAP = 40
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
function summary(item: DetailItem): string {
  const text = (item.fields ?? [])
    .slice(0, 2)
    .map((f) => clip(f.value, SUMMARY_VALUE_CAP))
    .join(' · ')
  return clip(text, SUMMARY_CAP)
}
</script>

<template>
  <!-- 编号列表：每项可点，等价于语音说编号 -->
  <view v-if="!selected" class="deal-list">
    <view v-for="it in detail.items" :key="it.index" class="deal-row" @tap="emit('select', it.index)">
      <template v-if="anyImage">
        <image v-if="it.image" class="deal-thumb" :src="it.image" mode="aspectFill" />
        <view v-else class="deal-thumb deal-thumb--empty" />
      </template>
      <view class="deal-row-text">
        <!-- 编号与标题同一行开头，读起来就是「1. 商品名」，不单独占一行留空 -->
        <view class="deal-row-head">
          <text class="deal-index">{{ it.index }}.</text>
          <text class="deal-title">{{ it.title }}</text>
        </view>
        <text v-if="summary(it)" class="deal-summary">{{ summary(it) }}</text>
      </view>
    </view>
    <text v-if="!detail.items.length" class="deal-empty">{{ t('detail.empty') }}</text>
  </view>

  <!-- 选中详情：有图才显示封面（优先大图、缺省回退缩略图），无图不占一块空白 -->
  <view v-else class="deal-detail">
    <image
      v-if="selected.imageLarge || selected.image"
      class="deal-cover"
      :src="selected.imageLarge || selected.image"
      mode="aspectFit"
    />
    <text class="deal-detail-title">{{ selected.title }}</text>
    <view v-for="(f, i) in (selected.fields ?? [])" :key="i" class="deal-field">
      <text class="deal-field-label">{{ f.label }}</text>
      <text class="deal-field-value">{{ f.value }}</text>
    </view>
    <text v-if="!selected.fields?.length" class="deal-empty">{{ t('detail.empty') }}</text>
    <text v-if="!selected.link" class="deal-no-link">{{ t('detail.noLink') }}</text>
  </view>
</template>

<style scoped>
.deal-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.deal-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
}
.deal-row:active {
  background: rgba(255, 255, 255, 0.1);
}
.deal-thumb {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.06);
}
.deal-thumb--empty {
  border: 1px dashed rgba(255, 255, 255, 0.12);
}
.deal-row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.deal-row-head {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}
.deal-index {
  font-size: 13px;
  line-height: 1.45;
  color: #6c8cff;
  flex-shrink: 0;
}
.deal-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.45;
  color: #e8eaf6;
}
.deal-summary {
  font-size: 11px;
  color: #9aa0bd;
}
.deal-empty,
.deal-no-link {
  font-size: 12px;
  color: #6f7691;
  line-height: 1.5;
}
.deal-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.deal-cover {
  width: 100%;
  height: 160px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
}
.deal-detail-title {
  font-size: 14px;
  font-weight: 600;
  color: #e8eaf6;
}
.deal-field {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.deal-field-label {
  width: 64px;
  flex-shrink: 0;
  font-size: 12px;
  color: #6f7691;
}
.deal-field-value {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: #cfd8ff;
  word-break: break-word;
}
</style>
