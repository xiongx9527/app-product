<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { onPullDownRefresh } from '@dcloudio/uni-app'
import { t } from '@/core/i18n'
import { useLongMemory, type MemoryItem } from '@/features/memory/memoryStore'
import { useSubPageBack } from '@/core/composables/useSubPageBack'
import SubPageNav from '@/components/SubPageNav.vue'
import { useThemeStyle } from '@/core/composables/useTheme'

const { themeStyle, dataTheme } = useThemeStyle()

const mem = useLongMemory()
const { items, total, page, totalPages, hasPrev, hasNext, loading, hint, query, formatTime, load, refresh, prev, next, search, remove, clearAll } = mem

const empty = computed(() => !loading.value && items.value.length === 0 && !hint.value)
const showHint = computed(() => !!hint.value)

function onSearch(e: any): void {
  const q = e?.detail?.value ?? e?.target?.value ?? ''
  search(q)
}

function onDelete(item: MemoryItem): void {
  uni.showModal({
    title: t('settings.memory.delete'),
    content: t('settings.memory.deleteConfirm'),
    success: (res) => {
      if (res.confirm) void remove(item)
    },
  })
}

function onClear(): void {
  uni.showModal({
    title: t('settings.memory.clearAll'),
    content: t('settings.memory.clearConfirm'),
    success: (res) => {
      if (res.confirm) void clearAll()
    },
  })
}

onMounted(() => {
  void load()
})

/** 下拉刷新（在列表顶部向下拉）：回到第 1 页重新加载，结束系统下拉指示器。 */
onPullDownRefresh(() => {
  void refresh().finally(() => uni.stopPullDownRefresh())
})

const { goBack } = useSubPageBack()
</script>

<template>
  <view class="page" :style="themeStyle" :data-theme="dataTheme">
    <SubPageNav :title="t('settings.memory.openLong')" @back="goBack" />

    <view class="head">
      <text v-if="total" class="count">{{ t('settings.memory.total', { n: total }) }}</text>
      <view
        v-if="items.length"
        class="act clear"
        @tap="onClear"
        :aria-label="t('settings.memory.clearAll')"
      >
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 6.5 17.5 8" />
          <path d="M13 2.5 11.5 4" />
          <path d="M21 11.5 19.5 13" />
          <path d="M13 7.5 11.5 9" />
          <path d="M15.5 9.5 14 11" />
          <path d="M19 14.5 17.5 16" />
          <path d="M15.5 18.5 14 20" />
          <path d="M4 21 13.5 11.5" />
          <path d="M4 21 5.5 19.5" />
        </svg>
      </view>
    </view>

    <input
      class="search"
      type="text"
      :value="query"
      :placeholder="t('settings.memory.search')"
      @input="onSearch"
    />

    <text v-if="showHint" class="hint">{{ hint }}</text>
    <text v-else-if="empty" class="hint">{{ t('settings.memory.empty') }}</text>

    <view v-for="item in items" :key="item.key" class="card">
      <view class="info">
        <text class="key">{{ item.key }}</text>
        <text class="value">{{ item.value }}</text>
        <view class="meta">
          <text class="time">{{ t('settings.memory.created') }} {{ formatTime(item.createdAt) }}</text>
          <text class="time">{{ t('settings.memory.updated') }} {{ formatTime(item.updatedAt) }}</text>
        </view>
      </view>
      <view class="act del" @tap="onDelete(item)" :aria-label="t('settings.memory.delete')">
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
      </view>
    </view>

    <view v-if="totalPages > 1" class="pager">
      <text class="link" :class="{ disabled: !hasPrev || loading }" @tap="prev">
        {{ loading ? '…' : t('settings.memory.prev') }}
      </text>
      <text class="page-ind">{{ t('settings.memory.page', { cur: page, total: totalPages }) }}</text>
      <text class="link" :class="{ disabled: !hasNext || loading }" @tap="next">
        {{ loading ? '…' : t('settings.memory.next') }}
      </text>
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

.act.clear {
  margin-left: auto;
  color: #ff8a8a;
}

.search {
  width: 100%;
  height: 36px;
  line-height: 36px;
  padding: 0 12px;
  border-radius: 10px;
  font-size: 13px;
  color: #e8eaf6;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-sizing: border-box;
}

.hint {
  font-size: 13px;
  line-height: 1.6;
  color: #6f7691;
  padding: 24px 4px;
}

.card {
  display: flex;
  align-items: flex-start;
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
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.key {
  font-size: 12px;
  font-weight: 600;
  color: #cfd8ff;
}

.value {
  font-size: 14px;
  color: #e8eaf6;
  line-height: 1.5;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 2px;
}

.time {
  font-size: 10px;
  color: rgba(232, 234, 246, 0.5);
  line-height: 1.4;
}

.link {
  font-size: 13px;
  color: var(--accent);
  flex-shrink: 0;
}

.link.disabled {
  opacity: 0.4;
}

/* 列表项右侧删除：垃圾桶图标（替代原来的「删除」文字按钮） */
.act {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
}

.act.del {
  color: #ff8a8a;
}

.act .ico {
  width: 18px;
  height: 18px;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 4px 0;
}

.page-ind {
  font-size: 12px;
  color: #b8bdd4;
}
</style>
