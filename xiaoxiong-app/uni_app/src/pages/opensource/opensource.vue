<script setup lang="ts">
import { t } from '@/core/i18n'
import type { DetailItem } from '@/core/transport/types'
import { useOpenSource } from '@/features/recommend/recommendStore'
import RecommendList from '@/features/recommend/RecommendList.vue'
import SubPageNav from '@/components/SubPageNav.vue'
import { useSubPageBack } from '@/core/composables/useSubPageBack'
import { useThemeStyle } from '@/core/composables/useTheme'

const { entries, remove, clear } = useOpenSource()
const { goBack } = useSubPageBack({ fallbackUrl: '/pages/index/index' })
const { themeStyle, dataTheme } = useThemeStyle()

/** 打开：把条目链接复制到剪贴板（不弹 toast，由列表组件行内提示「已复制」）。 */
function onOpen(item: DetailItem): void {
  if (item.link) uni.setClipboardData({ data: item.link, showToast: false })
}
</script>

<template>
  <view class="page" :style="themeStyle" :data-theme="dataTheme">
    <SubPageNav :title="t('opensource.title')" @back="goBack" />
    <RecommendList
      :entries="entries"
      :show-head="false"
      :empty-text="t('opensource.empty')"
      :open-label="t('opensource.open')"
      :remove-label="t('opensource.remove')"
      :clear-label="t('opensource.cleared')"
      @open="onOpen"
      @remove="remove"
      @clear="clear"
    />
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 16px 16px calc(32px + env(safe-area-inset-bottom));
  background:
    radial-gradient(120% 50% at 50% 0%, var(--bg-glow), transparent 60%),
    var(--bg-base);
}
</style>
