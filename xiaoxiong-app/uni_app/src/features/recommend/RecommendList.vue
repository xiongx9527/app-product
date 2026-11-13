<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '@/core/i18n'
import type { DetailItem } from '@/core/transport/types'
import type { RecommendEntry } from './recommendStore'
import { useThemeStyle } from '@/core/composables/useTheme'
import { readScreenInfo } from '@/core/adaptation/screen'

/**
 * 推荐列表通用视图（好价商品 / 开源工具共用）：分页展示持久化的推荐条目。
 * 只依赖统一 DetailItem 契约，不感知业务字段；打开/移除动作由父页面注入，
 * 因为「打开」在不同端行为不同（这里统一走复制链接），父页面只提供回调。
 */
const props = defineProps<{
  entries: RecommendEntry[]
  /** 仅 showHead=true 时需要（自带头部标题）。 */
  title?: string
  emptyText: string
  openLabel: string
  removeLabel: string
  clearLabel: string
  /** 是否渲染自带头部（标题+计数+返回）。作为子页嵌入时由外层 SubPageNav 接管，传 false 隐藏。 */
  showHead?: boolean
}>()

const showHead = props.showHead !== false

// 根元素响应式绑定主题变量：deals / opensource 两个列表页共用本组件，主题自动生效
const { themeStyle, dataTheme } = useThemeStyle()

// 顶部留白内联注入（与 SubPageNav 同一来源 statusBarHeight + 12），不依赖 scoped CSS：
// 这两页已开 navigationStyle: custom，状态栏让位必须由本组件自己处理，否则标题会顶进状态栏。
const pageStyle = { paddingTop: `${readScreenInfo().statusBarHeight + 12}px` }

/** 返回：列表页均由设置页 navigateTo 进入，直接 navigateBack 即可；异常时兜底回首页。 */
function goBack(): void {
  uni.navigateBack({ fail: () => uni.reLaunch({ url: '/pages/index/index' }) })
}

const emit = defineEmits<{
  open: [item: DetailItem]
  remove: [item: DetailItem]
  clear: []
}>()

/** 每页条数；推荐条目图文兼具，单页不宜过多，分页加载（与「分享是分页列表」一致）。 */
const PAGE_SIZE = 8

const page = ref(1)
const totalPages = computed(() => Math.max(1, Math.ceil(props.entries.length / PAGE_SIZE)))
const paged = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return props.entries.slice(start, start + PAGE_SIZE)
})

/** 翻页时若当前页越界（如清空后）夹回最后一页。 */
function goto(p: number): void {
  page.value = Math.min(Math.max(1, p), totalPages.value)
}
function prev(): void {
  goto(page.value - 1)
}
function next(): void {
  goto(page.value + 1)
}

/** 顶部临时提示（复制链接等），行内展示不弹 toast。 */
const notice = ref('')
let timer: ReturnType<typeof setTimeout> | null = null
function flash(msg: string): void {
  notice.value = msg
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => (notice.value = ''), 1500)
}

/** 父页面把「打开」实现为复制链接，并把结果用行内提示反馈。 */
function onOpen(item: DetailItem): void {
  emit('open', item)
  if (item.link) flash(t('detail.copied'))
}

function onRemove(item: DetailItem): void {
  emit('remove', item)
}

function onClear(): void {
  emit('clear')
  goto(1)
}

/** 列表里展示来源/语言/系统等短字段（与首页详情列表同一收敛规则）。 */
function shortFields(item: DetailItem): { label: string; value: string }[] {
  return (item.fields ?? [])
    .filter((f) => f.value.length <= 24)
    .slice(0, 3)
}

/** 推荐时间戳（秒）格式化为 YYYY-MM-DD HH:mm，仅展示用。 */
function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <view :class="showHead ? 'page' : 'list'" :style="showHead ? [pageStyle, themeStyle] : undefined" :data-theme="showHead ? dataTheme : undefined">
    <view v-if="showHead" class="head">
      <view class="nav-back" @tap="goBack">‹</view>
      <text class="title">{{ title }}</text>
      <text v-if="entries.length" class="count">{{ entries.length }}</text>
    </view>

    <text v-if="notice" class="notice">{{ notice }}</text>

    <text v-if="!entries.length" class="empty">{{ emptyText }}</text>

    <template v-else>
      <view v-for="entry in paged" :key="entry.item.link || entry.item.title" class="card">
        <view class="info">
          <text class="name">{{ entry.item.title }}</text>
          <view v-if="shortFields(entry.item).length" class="fields">
            <text v-for="(f, i) in shortFields(entry.item)" :key="i" class="field">
              <text class="field-label">{{ f.label }}</text><text class="field-value">{{ f.value }}</text>
            </text>
          </view>
          <text class="time">{{ formatTime(entry.addedAt) }}</text>
        </view>
        <view class="actions">
          <text class="act open" @tap="onOpen(entry.item)">{{ openLabel }}</text>
          <text class="act remove" @tap="onRemove(entry.item)">{{ removeLabel }}</text>
        </view>
      </view>

      <view v-if="totalPages > 1" class="pager">
        <text class="link" :class="{ disabled: page <= 1 }" @tap="prev">{{ t('settings.memory.prev') }}</text>
        <text class="page-ind">{{ t('settings.memory.page', { cur: page, total: totalPages }) }}</text>
        <text class="link" :class="{ disabled: page >= totalPages }" @tap="next">{{ t('settings.memory.next') }}</text>
      </view>

      <button class="clear" @tap="onClear">{{ clearLabel }}</button>
    </template>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  /* 顶部留白由 :style 的 pageStyle 注入（statusBarHeight + 12），此处不再定义 padding-top */
  padding: 0 16px calc(32px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 14px;
  background:
    radial-gradient(120% 50% at 50% 0%, var(--bg-glow), transparent 60%),
    var(--bg-base);
}

/* 作为子页嵌入（外层 SubPageNav 已处理状态栏让位与标题）时的纯内容容器：不再重复 .page 的
   背景/最小高度/顶部留白，只承接布局，主题变量由外层 .page 继承。 */
.list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nav-back {
  width: 28px;
  flex-shrink: 0;
  font-size: 24px;
  line-height: 1;
  color: var(--accent);
  text-align: center;
}

.title {
  font-size: 17px;
  font-weight: 600;
  color: var(--accent);
}

.count {
  font-size: 12px;
  color: var(--accent);
  background: rgba(var(--accent-rgb), 0.14);
  border-radius: 10px;
  padding: 1px 8px;
}

.notice {
  font-size: 12px;
  color: #5cd6b2;
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

.fields {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
}

.field {
  font-size: 11px;
  line-height: 1.5;
  color: #9aa0bd;
}

.field-label {
  color: #6f7691;
  margin-right: 4px;
}

.field-value {
  color: #9aa0bd;
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

.open {
  color: var(--accent);
}

.remove {
  color: #ff8a8a;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.link {
  font-size: 13px;
  color: var(--accent);
}

.link.disabled {
  color: #4a4f66;
}

.page-ind {
  font-size: 12px;
  color: #9aa0bd;
}

.clear {
  margin: 4px 0 0;
  height: 36px;
  line-height: 36px;
  border-radius: 10px;
  font-size: 13px;
  color: #ff8a8a;
  background: rgba(255, 138, 138, 0.1);
  border: 1px solid rgba(255, 138, 138, 0.25);
}

.clear::after {
  border: none;
}
</style>
