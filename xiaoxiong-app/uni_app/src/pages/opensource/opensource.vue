<script setup lang="ts">
import { t } from '@/core/i18n'
import type { DetailItem } from '@/core/transport/types'
import { useOpenSource } from '@/features/recommend/recommendStore'
import RecommendList from '@/features/recommend/RecommendList.vue'

const { entries, remove, clear } = useOpenSource()

/** 打开：把条目链接复制到剪贴板（不弹 toast，由列表组件行内提示「已复制」）。 */
function onOpen(item: DetailItem): void {
  if (item.link) uni.setClipboardData({ data: item.link, showToast: false })
}
</script>

<template>
  <RecommendList
    :entries="entries"
    :title="t('opensource.title')"
    :empty-text="t('opensource.empty')"
    :open-label="t('opensource.open')"
    :remove-label="t('opensource.remove')"
    :clear-label="t('opensource.cleared')"
    @open="onOpen"
    @remove="remove"
    @clear="clear"
  />
</template>
