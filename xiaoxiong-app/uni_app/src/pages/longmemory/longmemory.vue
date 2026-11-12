<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { t } from '@/core/i18n'
import { useLongMemory, type MemoryItem } from '@/features/memory/memoryStore'

const mem = useLongMemory()
const { items, total, page, totalPages, hasPrev, hasNext, loading, hint, query, formatTime, load, prev, next, search, remove, clearAll } = mem

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
  uni.setNavigationBarTitle({ title: t('settings.memory.openLong') })
  void load()
})
</script>

<template>
  <view class="page">
    <view class="head">
      <text class="title">{{ t('settings.memory.openLong') }}</text>
      <text v-if="total" class="count">{{ t('settings.memory.total', { n: total }) }}</text>
      <text v-if="items.length" class="link clear" @tap="onClear">{{ t('settings.memory.clearAll') }}</text>
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
      <text class="link" @tap="onDelete(item)">{{ t('settings.memory.delete') }}</text>
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

    <text class="refresh" :class="{ disabled: loading }" @tap="load">{{ loading ? '…' : t('settings.memory.refresh') }}</text>
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
    radial-gradient(120% 50% at 50% 0%, rgba(108, 140, 255, 0.18), transparent 60%),
    #0f1220;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title {
  font-size: 17px;
  font-weight: 600;
  color: #e8eaf6;
}

.count {
  font-size: 12px;
  color: #6c8cff;
  background: rgba(108, 140, 255, 0.14);
  border-radius: 10px;
  padding: 1px 8px;
}

.clear {
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
  color: #6c8cff;
  flex-shrink: 0;
}

.link.disabled {
  opacity: 0.4;
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

.refresh {
  align-self: center;
  font-size: 13px;
  color: #6c8cff;
  padding: 8px 0;
}

.refresh.disabled {
  opacity: 0.4;
}
</style>
