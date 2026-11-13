<script setup lang="ts">
import { readScreenInfo } from '@/core/adaptation/screen'
defineProps<{ title: string }>()
const emit = defineEmits<{ (e: 'back'): void }>()
// 状态栏让位统一在 SubPageNav 处理：用系统真实的 statusBarHeight（横竖屏一致；
// env(safe-area-inset-top) 在部分机型返回 0，靠不住），保证所有子页标题位置一致。
const navStyle = { paddingTop: `${readScreenInfo().statusBarHeight + 12}px` }
</script>

<template>
  <view class="nav-bar" :style="navStyle">
    <view class="nav-back" @tap="emit('back')">‹</view>
    <text class="nav-title">{{ title }}</text>
  </view>
</template>

<style scoped>
.nav-bar {
  position: relative;
  display: flex;
  align-items: center;
  margin: -16px -16px 0;
  padding: 0 16px 12px;
  /* 顶部随主题：底色用主题背景，叠一层主题辉光，避免一整条死黑。顶部留白由 :style 的 paddingTop 注入 */
  background:
    radial-gradient(120% 120% at 50% 0%, var(--bg-glow), transparent 70%),
    var(--bg-base);
  border-bottom: 1px solid rgba(var(--accent-rgb), 0.22);
}

.nav-back {
  position: relative;
  z-index: 1;
  width: 28px;
  font-size: 26px;
  line-height: 1;
  color: var(--accent);
  text-align: center;
  flex-shrink: 0;
}

.nav-title {
  position: absolute;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 17px;
  font-weight: 600;
  color: var(--accent);
}
</style>
