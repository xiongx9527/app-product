import { ref, computed } from 'vue'
import { secureRequest } from '@/core/transport/secureRequest'
import { resolveGatewayHttpBase } from '@/core/transport/webSocketTransport'
import { getDeviceId } from '@/core/config/deviceId'
import { t } from '@/core/i18n'

/** 单条长期记忆：话题 + 内容 + 创建/更新时间（秒级时间戳）。 */
export interface MemoryItem {
  key: string
  value: string
  createdAt: number
  updatedAt: number
}

interface MemoryPageBody {
  items: MemoryItem[]
  total: number
  page: number
  pageSize: number
}

/** 长期记忆列表每页条数：网关按 page / pageSize 分页返回，前端替换式翻页。 */
const PAGE_SIZE = 5

/**
 * 长期记忆：从网关按本机 deviceId 拉取，可关键词检索、单条删除或清空。
 * 网关是唯一存储源（SQLite），客户端经 /api/admin/memories 读写，不落本机业务数据。
 * 设置页的「记忆设置」入口与独立的「长期记忆」分页列表共用本 store。
 */
export function useLongMemory() {
  const items = ref<MemoryItem[]>([])
  const total = ref(0)
  const page = ref(1)
  const pageSize = ref(PAGE_SIZE)
  const query = ref('')
  const loading = ref(false)
  const hint = ref('')

  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
  const hasPrev = computed(() => page.value > 1)
  const hasNext = computed(() => page.value < totalPages.value)

  function baseUrl(): string {
    return `${resolveGatewayHttpBase()}/api/admin/memories?deviceId=${encodeURIComponent(getDeviceId())}`
  }

  function pageUrl(): string {
    const kw = query.value.trim()
    return `${baseUrl()}&page=${page.value}&pageSize=${pageSize.value}${kw ? `&q=${encodeURIComponent(kw)}` : ''}`
  }

  /** 记忆更新时间（秒级时间戳）格式化为 YYYY-MM-DD，仅展示用。 */
  function formatTime(ts: number): string {
    if (!ts) return ''
    const d = new Date(ts * 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  async function load(): Promise<void> {
    if (loading.value) return
    loading.value = true
    hint.value = ''
    try {
      const res = await secureRequest({ url: pageUrl(), method: 'GET' })
      const body = res.data as MemoryPageBody | null
      if (res.statusCode >= 200 && res.statusCode < 300 && body && Array.isArray(body.items)) {
        items.value = body.items as MemoryItem[]
        total.value = typeof body.total === 'number' ? body.total : items.value.length
        // 删除条目后当前页可能越界（如删掉末页唯一一条），回退到最后一页重新拉取。
        if (items.value.length === 0 && page.value > 1 && total.value > 0) {
          page.value = totalPages.value
          void load()
        }
      } else {
        hint.value = t('settings.memory.loadFailed')
      }
    } catch {
      hint.value = t('settings.memory.loadFailed')
    } finally {
      loading.value = false
    }
  }

  /** 仅刷新总数（设置页入口角标用），不拉取整页，轻量。 */
  async function loadTotal(): Promise<void> {
    try {
      const res = await secureRequest({ url: `${baseUrl()}&page=1&pageSize=1`, method: 'GET' })
      const body = res.data as MemoryPageBody | null
      if (res.statusCode >= 200 && res.statusCode < 300 && body) {
        total.value = typeof body.total === 'number' ? body.total : 0
      }
    } catch {
      // 角标失败静默：不阻塞设置页其它功能
    }
  }

  function goto(p: number): void {
    const target = Math.min(Math.max(1, p), totalPages.value)
    if (target === page.value) return
    page.value = target
    void load()
  }

  function prev(): void {
    goto(page.value - 1)
  }

  function next(): void {
    goto(page.value + 1)
  }

  function search(q: string): void {
    query.value = q
    page.value = 1
    void load()
  }

  async function remove(item: MemoryItem): Promise<void> {
    try {
      const res = await secureRequest({
        url: `${baseUrl()}&key=${encodeURIComponent(item.key)}`,
        method: 'DELETE',
      })
      if (res.statusCode >= 200 && res.statusCode < 300) {
        hint.value = t('settings.memory.deleted')
        void load()
      } else {
        hint.value = t('settings.memory.loadFailed')
      }
    } catch {
      hint.value = t('settings.memory.loadFailed')
    }
  }

  async function clearAll(): Promise<void> {
    try {
      const res = await secureRequest({ url: baseUrl(), method: 'DELETE' })
      if (res.statusCode >= 200 && res.statusCode < 300) {
        items.value = []
        total.value = 0
        page.value = 1
        hint.value = t('settings.memory.cleared')
      } else {
        hint.value = t('settings.memory.loadFailed')
      }
    } catch {
      hint.value = t('settings.memory.loadFailed')
    }
  }

  return {
    items,
    total,
    page,
    totalPages,
    hasPrev,
    hasNext,
    query,
    loading,
    hint,
    formatTime,
    load,
    loadTotal,
    goto,
    prev,
    next,
    search,
    remove,
    clearAll,
  }
}
