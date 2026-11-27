<script setup lang="ts">
import { computed } from 'vue'
import type { ReportBlock } from '@/core/transport/types'
import { appConfig } from '@/core/config'
import { resolveImageUrl } from '@/core/text/imageUrl'

/**
 * 图片块渲染器：展示后端出图的 PNG。url 可为相对路径（/api/chart/image/xxx），
 * 按当前语音服务地址拼绝对（与助手回复 markdown 图片同一套规则）。
 * 与商品详情封面无关，只依赖协议层 image 块。
 */
type ImageBlock = Extract<ReportBlock, { type: 'image' }>
const props = defineProps<{ block: ImageBlock }>()

/** 用当前服务地址把相对图床路径拼成可加载的绝对地址；危险协议返回空串则不渲染。 */
const src = computed(() => resolveImageUrl(props.block.url, appConfig.voice.builtin.url))
</script>

<template>
  <image v-if="src" class="report-image" :src="src" mode="widthFix" />
</template>

<style scoped>
.report-image {
  display: block;
  width: 100%;
  border-radius: 8px;
}
</style>
