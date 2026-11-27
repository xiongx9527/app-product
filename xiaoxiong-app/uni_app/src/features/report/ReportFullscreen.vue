<script setup lang="ts">
import { t } from '@/core/i18n'

/**
 * 通用报表全屏容器：fixed 遮罩 + 头部（标题 + 关闭）+ 滚动内容 slot + 底部操作 slot。
 * 零业务、不认识图表/表格——内容完全由 slot 决定（复用 ReportToolbar/ChartRenderer）。
 * 点遮罩或关闭退出；不新增页面路由，不动 FloatLayer 层级注册。
 */
withDefaults(
  defineProps<{
    visible: boolean
    title?: string
  }>(),
  { title: '' },
)

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <view v-if="visible" class="report-fullscreen" @tap.self="emit('close')">
    <view class="fullscreen-panel">
      <view class="fullscreen-head">
        <text class="fullscreen-title">{{ title || t('report.title') }}</text>
        <!-- 通用工具位：由调用方塞入操作按钮（如下载/复制链接），本容器不认识业务 -->
        <view v-if="$slots.tools" class="fullscreen-tools">
          <slot name="tools" />
        </view>
        <view class="fullscreen-close" :aria-label="t('report.close')" @tap="emit('close')">
          <image class="close-icon" src="/static/icons/close.svg" mode="aspectFit" />
        </view>
      </view>
      <scroll-view scroll-y class="fullscreen-body">
        <slot />
      </scroll-view>
      <view v-if="$slots.footer" class="fullscreen-footer">
        <slot name="footer" />
      </view>
    </view>
  </view>
</template>

<style scoped>
.report-fullscreen {
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 10000;
  background: rgba(0, 0, 0, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-sizing: border-box;
}
.fullscreen-panel {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #161b2b;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  padding: 16px;
  box-sizing: border-box;
}
.fullscreen-head {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.fullscreen-title {
  font-size: 15px;
  font-weight: 600;
  color: #e8eaf6;
  flex: 1;
  min-width: 0;
}
.fullscreen-tools {
  display: flex;
  flex-direction: row;
  align-items: center;
  margin-right: 10px;
}
.fullscreen-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
}
.close-icon {
  width: 14px;
  height: 14px;
}
.fullscreen-body {
  flex: 1;
  min-height: 0;
}
.fullscreen-footer {
  margin-top: 12px;
}
</style>
