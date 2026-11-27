<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import type { ReportBlock } from '@/core/transport/types'
import { resolveReportBlock } from './registry'

/**
 * 报表块分派器：遍历有序 blocks，按 block.type 查注册表取组件渲染。
 * 自身零业务、不认识任何内容类型字段；新增类型只加注册表项。
 * 未知 type 中性跳过，不让脏数据把卡片弄崩。
 */
const props = defineProps<{ blocks: ReportBlock[] }>()

interface RenderedBlock {
  block: ReportBlock
  component: Component
}

/** 一次解析出「块 + 组件」配对，未知 type 直接过滤；模板不再重复查表。 */
const rendered = computed<RenderedBlock[]>(() =>
  props.blocks
    .map((block) => {
      const meta = resolveReportBlock(block.type)
      return meta ? { block, component: meta.component } : null
    })
    .filter((item): item is RenderedBlock => item !== null),
)
</script>

<template>
  <view class="report-blocks">
    <component v-for="(item, i) in rendered" :key="i" :is="item.component" :block="item.block" />
  </view>
</template>

<style scoped>
.report-blocks {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
