<script setup lang="ts">
defineProps<{ title: string }>()
const emit = defineEmits<{ (e: 'back'): void }>()
</script>

<template>
  <view class="nav-bar">
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
  padding: calc(env(safe-area-inset-top) + 12px) 16px 12px;
  background: var(--bg-base);
  border-bottom: 1px solid rgba(var(--accent-rgb), 0.16);
}

.nav-back {
  position: relative;
  z-index: 1;
  width: 28px;
  font-size: 26px;
  line-height: 1;
  color: #ffffff;
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
  color: #e8eaf6;
}
</style>
