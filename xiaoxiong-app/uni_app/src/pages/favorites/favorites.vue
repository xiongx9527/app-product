<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/core/i18n'
import { useFavorites } from '@/features/favorites/favoritesStore'
import { playMusic } from '@/core/audio/musicPlayer'
import { useSubPageBack } from '@/core/composables/useSubPageBack'
import SubPageNav from '@/components/SubPageNav.vue'
import { useThemeStyle } from '@/core/composables/useTheme'

const { themeStyle, dataTheme } = useThemeStyle()

const { favorites, removeFavorite } = useFavorites()

/** 收藏时间戳（秒）格式化为 YYYY-MM-DD HH:mm，仅展示用。 */
function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const empty = computed(() => favorites.value.length === 0)

function onPlay(url: string, title: string): void {
  playMusic(url, title)
}

function onRemove(url: string): void {
  removeFavorite(url)
}

const { goBack } = useSubPageBack()
</script>

<template>
  <view class="page" :style="themeStyle" :data-theme="dataTheme">
    <SubPageNav :title="t('favorites.title')" @back="goBack" />

    <view class="head">
      <text v-if="!empty" class="count">{{ favorites.length }}</text>
    </view>

    <text v-if="empty" class="empty">{{ t('favorites.empty') }}</text>

    <view v-for="item in favorites" :key="item.url" class="card">
      <view class="info">
        <text class="name">{{ item.title }}</text>
        <text class="time">{{ t('favorites.addedAt', { time: formatTime(item.addedAt) }) }}</text>
      </view>
      <view class="actions">
        <text class="act play" @tap="onPlay(item.url, item.title)">{{ t('favorites.play') }}</text>
        <text class="act remove" @tap="onRemove(item.url)">{{ t('favorites.remove') }}</text>
      </view>
    </view>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 16px 16px calc(32px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 14px;
  background:
    radial-gradient(120% 50% at 50% 0%, var(--bg-glow), transparent 60%),
    var(--bg-base);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.count {
  font-size: 12px;
  color: var(--accent);
  background: rgba(var(--accent-rgb), 0.14);
  border-radius: 10px;
  padding: 1px 8px;
}

.empty {
  font-size: 13px;
  line-height: 1.6;
  color: #6f7691;
  padding: 24px 4px;
}

.card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.name {
  font-size: 14px;
  color: #e8eaf6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.time {
  font-size: 11px;
  color: #6f7691;
}

.actions {
  display: flex;
  gap: 12px;
  flex-shrink: 0;
}

.act {
  font-size: 13px;
}

.play {
  color: var(--accent);
}

.remove {
  color: #ff8a8a;
}
</style>
