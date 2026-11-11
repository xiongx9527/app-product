import { ref } from 'vue'
import type { DetailItem, MediaDetail } from '@/core/transport/types'

/**
 * 推荐结果持久化（客户端本地）。
 *
 * 助手每次推荐好价商品（media.detail.kind=deals）或开源工具（kind=project）时，
 * 把返回的条目按 link（缺省回退 title）去重后追加进对应列表并落盘，使「推荐设置」里的列表入口
 * 能像「我的收藏」一样回看历史推荐。上限 100 条，超出丢弃最旧的。
 *
 * 与 favoritesStore 的区别：这里真正持久化（uni.setStorageSync），因为推荐结果来自联网抓取、
 * 回看价值高；记忆/去重语义保持一致（同链接不重复加入）。
 */
const STORAGE_KEYS = {
  deals: 'app-product.recommend.deals.v1',
  opensource: 'app-product.recommend.opensource.v1',
} as const

/** 单条推荐记录：何时推荐 + 原始 DetailItem（统一字段契约，不感知业务）。 */
export interface RecommendEntry {
  /** 加入时间戳（秒） */
  addedAt: number
  item: DetailItem
}

/** 单列表最多保留多少条，超出丢弃最旧的。 */
const MAX_ENTRIES = 100

function load(key: string): RecommendEntry[] {
  try {
    if (typeof uni !== 'undefined' && typeof uni.getStorageSync === 'function') {
      const raw = uni.getStorageSync(key)
      if (Array.isArray(raw)) return raw as RecommendEntry[]
    }
  } catch {
    // 读取失败退回空列表，不阻断推荐流程
  }
  return []
}

function save(key: string, list: RecommendEntry[]): void {
  try {
    if (typeof uni !== 'undefined' && typeof uni.setStorageSync === 'function') {
      uni.setStorageSync(key, list)
    }
  } catch {
    // 持久化失败不阻断：内存态仍可用
  }
}

const deals = ref<RecommendEntry[]>(load(STORAGE_KEYS.deals))
const opensource = ref<RecommendEntry[]>(load(STORAGE_KEYS.opensource))

/** 去重主键：优先 link（商品/项目页地址），缺失时用 title。 */
function keyOf(item: DetailItem): string {
  return (item.link ?? '').trim() || item.title
}

function addTo(store: typeof deals, key: string, items: DetailItem[]): void {
  const existing = new Set(store.value.map((e) => keyOf(e.item)))
  // 只收新增的：已在列表里的（重听同一推荐）不再重复加入，避免堆积。
  const incoming = items.filter((it) => it && !existing.has(keyOf(it)))
  if (!incoming.length) return
  const now = Math.floor(Date.now() / 1000)
  store.value = [
    ...incoming.map((it) => ({ addedAt: now, item: it })),
    ...store.value,
  ].slice(0, MAX_ENTRIES)
  save(key, store.value)
}

function removeFrom(store: typeof deals, key: string, item: DetailItem): void {
  const k = keyOf(item)
  const next = store.value.filter((e) => keyOf(e.item) !== k)
  if (next.length === store.value.length) return
  store.value = next
  save(key, store.value)
}

function clearStore(store: typeof deals, key: string): void {
  store.value = []
  save(key, [])
}

/**
 * 捕获一次推荐结果：按 media.detail.kind 分流到好价/开源列表。
 * 仅在列表形态（selectedIndex 为空，非详情/收起）且有条目时收，避免选中单条时重复写。
 */
export function captureRecommendation(detail: MediaDetail): void {
  if (detail.close) return
  if (detail.selectedIndex != null) return
  const items = detail.items
  if (!items || !items.length) return
  if (detail.kind === 'deals') addTo(deals, STORAGE_KEYS.deals, items)
  else if (detail.kind === 'project') addTo(opensource, STORAGE_KEYS.opensource, items)
}

export function useDeals() {
  return {
    entries: deals,
    remove: (item: DetailItem) => removeFrom(deals, STORAGE_KEYS.deals, item),
    clear: () => clearStore(deals, STORAGE_KEYS.deals),
  }
}

export function useOpenSource() {
  return {
    entries: opensource,
    remove: (item: DetailItem) => removeFrom(opensource, STORAGE_KEYS.opensource, item),
    clear: () => clearStore(opensource, STORAGE_KEYS.opensource),
  }
}
