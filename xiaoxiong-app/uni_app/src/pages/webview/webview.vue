<script setup lang="ts">
import { ref } from 'vue'
import { onLoad } from '@dcloudio/uni-app'

/**
 * 独立网页页：详情卡片「打开原网页」跳到这里，用系统导航栏的返回键回上一页。
 * App 端 web-view 是原生组件、层级最高，内嵌在详情卡片里时任何 DOM/cover-view 返回条
 * 都会被它盖住点不到（用户点开后回不去）——所以网页必须单独占一个页面，由平台导航返回。
 */
const url = ref('')
onLoad((options) => {
  const raw = options?.url
  url.value = typeof raw === 'string' ? decodeURIComponent(raw) : ''
})
</script>

<template>
  <web-view v-if="url" :src="url" />
</template>
