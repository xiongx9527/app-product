<script setup lang="ts">
import { t } from '@/core/i18n'

/**
 * 通用内容卡片容器：只负责「标题 + 关闭 + 内容 slot + 操作栏 slot」，
 * 零业务、零 kind 判断、不悬浮（页面文档流内，和播放条 / 字幕面板同层）。
 *
 * 「和播放器一样单独出来」：由使用方把它放在助手回复流（.cards）之外的同级区块，
 * 后续对话更新回复卡片不会顶掉它。任何内容类型（商品详情 / 纯文本 / 开源项目 /
 * 图表报表 / 嵌入页）都复用本容器，新增分类不必改这里。
 */
const props = withDefaults(
  defineProps<{
    /** 卡片标题，由业务按分类经 i18n 注入 */
    title: string
    /** 关闭按钮的无障碍文案（详情形态下语义是「返回列表」），缺省用「关闭」 */
    closeLabel?: string
  }>(),
  { closeLabel: '' },
)

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <view class="detail-card">
    <view class="detail-head">
      <text class="detail-title">{{ title }}</text>
      <view class="detail-close" :aria-label="props.closeLabel || t('detail.close')" @tap="emit('close')">
        <image class="detail-close-icon" src="/static/icons/close.svg" mode="aspectFit" />
      </view>
    </view>

    <view class="detail-body">
      <slot />
    </view>

    <view v-if="$slots.actions" class="detail-actions">
      <slot name="actions" />
    </view>
  </view>
</template>

<style scoped>
.detail-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.detail-title {
  font-size: 13px;
  font-weight: 600;
  color: #9be8cd;
  flex: 1;
  min-width: 0;
}

.detail-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  flex-shrink: 0;
}

.detail-close-icon {
  width: 16px;
  height: 16px;
}

.detail-body {
  min-width: 0;
}

.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
</style>
