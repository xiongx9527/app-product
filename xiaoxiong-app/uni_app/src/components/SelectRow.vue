<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '@/core/i18n'

interface Option {
  value: string
  label: string
}

const props = defineProps<{
  title: string
  hint?: string
  options: Option[]
  modelValue: string
  disabled?: boolean
  /** 选项较多时开启搜索框（如 DashScope 模型目录很长，便于定位） */
  searchable?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const searchText = ref('')

const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue
)

// 搜索：按 value / label 子串（大小写不敏感）过滤；关闭时清空输入。
const filteredOptions = computed(() => {
  if (!props.searchable || !searchText.value.trim()) return props.options
  const q = searchText.value.trim().toLowerCase()
  return props.options.filter(
    (o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)
  )
})

function toggle(): void {
  if (props.disabled) return
  open.value = !open.value
  if (!open.value) searchText.value = ''
}

function choose(value: string): void {
  emit('update:modelValue', value)
  open.value = false
  searchText.value = ''
}

function onSearch(e: Event): void {
  // uni-app 的 input 事件以 e.detail.value 携带输入值（与 DOM 的 e.target.value 不同）
  const detail = (e as unknown as { detail?: { value?: string } }).detail
  if (detail?.value !== undefined) searchText.value = detail.value
}
</script>

<template>
  <view class="select-row">
    <view class="row" :class="{ disabled }" @tap="toggle">
      <view class="row-text">
        <text class="row-label">{{ title }}</text>
        <text v-if="hint" class="hint">{{ hint }}</text>
      </view>
      <view class="row-right">
        <text class="row-value">{{ currentLabel }}</text>
        <text class="arrow" :class="{ up: open }">›</text>
      </view>
    </view>

    <!-- 展开时用一个占满屏幕的透明遮罩接住外部点击，关掉下拉 -->
    <view v-if="open" class="mask" @tap="open = false" />
    <view v-if="open" class="options">
      <input
        v-if="searchable"
        class="search"
        :placeholder="t('select.searchPlaceholder')"
        :value="searchText"
        @input="onSearch"
      />
      <view
        v-for="opt in filteredOptions"
        :key="opt.value"
        class="option"
        :class="{ active: opt.value === modelValue }"
        @tap="choose(opt.value)"
      >
        <text class="option-label">{{ opt.label }}</text>
        <text v-if="opt.value === modelValue" class="check">✓</text>
      </view>
      <text v-if="searchable && filteredOptions.length === 0" class="hint search-empty">
        {{ t('settings.voice.llmModelEmpty') }}
      </text>
    </view>
  </view>
</template>

<style scoped>
.select-row {
  position: relative;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.row.disabled {
  opacity: 0.5;
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.row-label {
  font-size: 13px;
  color: #e8eaf6;
}

.row-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.row-value {
  font-size: 14px;
  color: #e8eaf6;
  text-align: right;
}

.arrow {
  font-size: 16px;
  color: #6f7691;
  transform: rotate(90deg);
  transition: transform 0.15s ease;
}

.arrow.up {
  transform: rotate(-90deg);
}

.hint {
  font-size: 11px;
  line-height: 1.5;
  color: #6f7691;
  word-break: break-word;
}

.mask {
  position: fixed;
  inset: 0;
  z-index: 20;
}

.options {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 6px);
  z-index: 21;
  max-height: 240px;
  overflow-y: auto;
  padding: 6px;
  border-radius: 12px;
  background: #1b1f33;
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}

.option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
}

.option.active {
  background: rgba(108, 140, 255, 0.16);
}

.option-label {
  font-size: 13px;
  color: #e8eaf6;
}

.check {
  font-size: 13px;
  color: #6c8cff;
}

/* 搜索框：仅在 searchable 下拉里出现，便于在长模型目录里定位 */
.search {
  width: 100%;
  box-sizing: border-box;
  min-height: 34px;
  margin-bottom: 6px;
  padding: 7px 10px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #e8eaf6;
  font-size: 13px;
}

.search-empty {
  display: block;
  padding: 6px 4px 2px;
}
</style>
