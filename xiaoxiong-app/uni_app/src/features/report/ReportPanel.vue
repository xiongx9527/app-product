<script setup lang="ts">
import { provide } from 'vue'
import { t } from '@/core/i18n'

/**
 * 报表展示区的通用容器：只负责「标题 + 关闭 + 内容 slot」，
 * 零业务、零 type 判断、不悬浮、不朗读（同字幕/详情口径）。
 *
 * 与商品详情容器 DetailCard.vue 视觉语言一致但**完全独立**（两个组件、两套状态、两条事件）：
 * 本容器在助手回复框正下方（.cards 内），DetailCard 在页面底部独立面板，互不复用。
 * 里面装什么是 ReportBlocks 按 block.type 注册表分派的事，容器不感知。
 */
const props = withDefaults(
  defineProps<{
    /** 报表标题（网关按会话 lang 取；空串时业务方传 i18n 兜底） */
    title: string
    /** 是否含 chart 块：含则工具栏由 ReportChart 统一渲染（关闭按钮也在那一行），本容器不再单独画关闭 */
    hasChart?: boolean
  }>(),
  { title: '', hasChart: false },
)

const emit = defineEmits<{ close: [] }>()
function doClose(): void { emit('close') }
/** 供内层 ReportChart 工具栏复用标题与关闭能力，让标题、所有按钮、关闭在同一行。 */
provide('reportClose', doClose)
provide('reportTitle', () => props.title || t('report.title'))
</script>

<template>
  <view class="report-panel">
    <!-- 有 chart 块时：标题与所有按钮（含关闭）由 ReportChart 在同一行渲染，这里不再画 head -->
    <view v-if="!hasChart" class="report-head">
      <text class="report-title">{{ title || t('report.title') }}</text>
      <view class="report-close" :aria-label="t('report.close')" @tap="emit('close')">
        <image class="report-close-icon" src="/static/icons/close.svg" mode="aspectFit" />
      </view>
    </view>
    <view class="report-body">
      <slot />
    </view>
  </view>
</template>

<style scoped>
.report-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.report-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.report-title {
  font-size: 13px;
  font-weight: 600;
  color: #9be8cd;
  flex: 1;
  min-width: 0;
}
.report-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  flex-shrink: 0;
}
.report-close-icon {
  width: 16px;
  height: 16px;
}
.report-body {
  min-width: 0;
}
</style>
