<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'
import { t } from '@/core/i18n'
import { useSubPageBack } from '@/core/composables/useSubPageBack'
import SubPageNav from '@/components/SubPageNav.vue'

/**
 * 通用内嵌网页页：详情卡片点「打开」进来，web-view 载入原网页；
 * 点左上返回（或安卓物理返回键）回到详情卡片——详情状态在上一页，不丢。
 * url 由入口 encodeURIComponent 后透传，这里解码；无 url 时如实提示。
 */
const url = ref('')
const { goBack } = useSubPageBack({ fallbackUrl: '/pages/index/index' })

onLoad((opts) => {
  const raw = opts?.url
  if (typeof raw === 'string' && raw) {
    try { url.value = decodeURIComponent(raw) } catch { url.value = raw }
  }
})
</script>

<template>
  <view class="webview-page">
    <view class="nav-wrap">
      <SubPageNav :title="t('detail.open')" @back="goBack" />
    </view>
    <web-view v-if="url" :src="url" class="webview" />
    <view v-else class="no-url">{{ t('detail.noLink') }}</view>
  </view>
</template>

<style scoped>
.webview-page {
  position: relative;
  width: 100%;
  height: 100vh;
}
.nav-wrap {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
}
.webview {
  width: 100%;
  height: 100vh;
  /* 给顶部返回条让位，避免网页内容被返回条盖住 */
  padding-top: 60px;
}
.no-url {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  font-size: 14px;
  color: #8b91ab;
}
</style>
