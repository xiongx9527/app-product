<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '@/core/i18n'
import type { DetailField, DetailItem, MediaDetail } from '@/core/transport/types'

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

/**
 * 列表里也要能看到关键信息（来源、开发语言、系统、收录时间等），不只标题。
 * 只挑较短的字段做预览：整段简介/优惠说明这类长正文留给详情，避免把每项撑成好几行。
 * 不认识任何字段名，纯按长度与顺序收敛——换源、加字段都不改这里。
 */
const LIST_FIELD_CAP = 4
const SHORT_VALUE_CAP = 24
function listFields(item: DetailItem): DetailField[] {
  return (item.fields ?? []).filter((f) => f.value.length <= SHORT_VALUE_CAP).slice(0, LIST_FIELD_CAP)
}

/**
 * 详情内切换「字段视图 ↔ 原网页视图」：不弹新页面、不丢详情状态。
 * web-view 是原生组件、层级最高，会盖住普通 view，所以网页态下字段区整块换成 web-view，
 * 顶部返回条用 cover-view 盖在 web-view 上。切换选中项/关详情时自动回到字段态。
 */
const showWeb = ref(false)
watch(
  () => [props.detail.selectedIndex, props.detail.kind] as const,
  () => { showWeb.value = false },
)
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
        <!-- 列表里也展示来源/语言/系统等短字段，紧凑成一行行小字 -->
        <view v-if="listFields(it).length" class="deal-row-fields">
          <text v-for="(f, i) in listFields(it)" :key="i" class="deal-row-field">
            <text class="deal-row-field-label">{{ f.label }}</text><text class="deal-row-field-value">{{ f.value }}</text>
          </text>
        </view>
      </view>
    </view>
    <text v-if="!detail.items.length" class="deal-empty">{{ t('detail.empty') }}</text>
  </view>

  <!-- 选中详情：网页态 / 字段态 在同一块区域切换，不弹新页面、不丢详情状态 -->
  <view v-else class="deal-detail">
    <!-- 网页态：web-view 原生组件层级最高，占满这块区域；返回条用 cover-view 盖其上 -->
    <view v-if="showWeb && selected?.link" class="web-wrap">
      <web-view :src="selected.link" class="web-view" />
      <cover-view class="web-back" @tap="showWeb = false">‹ {{ t('detail.backToDetail') }}</cover-view>
    </view>
    <!-- 字段态（默认）：有图才显示封面（优先大图、缺省回退缩略图），无图不占一块空白 -->
    <template v-else>
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
      <!-- 打开原网页：详情内切换到网页视图（不弹新页面） -->
      <view v-if="selected.link" class="open-link" @tap="showWeb = true">
        <text class="open-link-text">{{ t('detail.open') }}</text>
        <text class="open-link-arrow">›</text>
      </view>
      <text v-else class="deal-no-link">{{ t('detail.noLink') }}</text>
    </template>
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
  color: var(--accent);
  flex-shrink: 0;
}
.deal-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.45;
  color: #e8eaf6;
}
.deal-row-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
}
.deal-row-field {
  font-size: 11px;
  line-height: 1.5;
  color: #9aa0bd;
}
.deal-row-field-label {
  color: #6f7691;
  margin-right: 4px;
}
.deal-row-field-value {
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
  /* 详情封面：由 160px 加大到 220px，商品方图/竖图能看清；仍 aspectFit 不裁切。
     不用 CSS min()/vh——App 端视图层对这些支持不一，固定像素最稳（已知 App 逻辑层/CSS API 差异坑）。 */
  height: 220px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06);
}
/* 详情内网页视图：web-view 原生组件占满这块区域，返回条用 cover-view 盖在上面 */
.web-wrap {
  position: relative;
  width: 100%;
  height: 380px;
  border-radius: 10px;
  overflow: hidden;
}
.web-view {
  width: 100%;
  height: 380px;
}
.web-back {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 20;
  padding: 6px 12px;
  background: rgba(15, 18, 32, 0.88);
  color: #9be8cd;
  font-size: 13px;
  border-radius: 0 0 10px 0;
}
/* 打开原网页入口行：与字段区风格一致，点它详情内切到网页 */
.open-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(var(--accent-rgb), 0.12);
  border: 1px solid rgba(var(--accent-rgb), 0.25);
}
.open-link-text {
  font-size: 13px;
  color: var(--accent);
}
.open-link-arrow {
  font-size: 18px;
  color: var(--accent);
  line-height: 1;
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
