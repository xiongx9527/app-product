<script setup lang="ts">
import { t } from '@/core/i18n'
import type { DetailItem } from '@/core/transport/types'
import { useDeals } from '@/features/recommend/recommendStore'
import RecommendList from '@/features/recommend/RecommendList.vue'

const { entries, remove, clear } = useDeals()

/** 打开：把条目链接复制到剪贴板（不弹 toast，由列表组件行内提示「已复制」）。 */
function onOpen(item: DetailItem): void {
  if (item.link) uni.setClipboardData({ data: item.link, showToast: false })
}
</script>

<template>
  <RecommendList
    :entries="entries"
    :title="t('deals.title')"
    :empty-text="t('deals.empty')"
    :open-label="t('deals.open')"
    :remove-label="t('deals.remove')"
    :clear-label="t('deals.cleared')"
    @open="onOpen"
    @remove="remove"
    @clear="clear"
  />
</template>
