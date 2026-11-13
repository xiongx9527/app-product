<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { appConfig, persistConfig } from '@/core/config'
import type { McpServerConfig, McpTransport } from '@/core/config/types'
import { t } from '@/core/i18n'
import { useSubPageBack } from '@/core/composables/useSubPageBack'
import SubPageNav from '@/components/SubPageNav.vue'
import { useThemeStyle } from '@/core/composables/useTheme'

const { themeStyle, dataTheme } = useThemeStyle()

const TRANSPORTS: McpTransport[] = ['sse', 'http']

/** 生成本地稳定 id（仅列表 key 与持久化用，不下发网关）。 */
function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function defaultServer(): McpServerConfig {
  return { id: newId(), name: '', enabled: true, transport: 'sse' }
}

const servers = computed(() => appConfig.mcp.servers)
const empty = computed(() => servers.value.length === 0)

/** 是否正在编辑一个尚未保存过的新服务器：新建可改传输方式，已保存则锁定（协议固定）。 */
const isNewServer = ref(false)
const transportLocked = computed(() => !isNewServer.value)

// 编辑态：null 表示列表视图；非 null 表示正在编辑该 id 的服务器（主从结构，无折叠）。
const editingId = ref<string | null>(null)
const isEditing = computed(() => editingId.value !== null)
const editing = computed(() => servers.value.find((s) => s.id === editingId.value) ?? null)
const saving = ref(false)

/** 编辑会话开始时的快照，供「取消」还原本次改动（不落盘）。 */
let initialSnapshot = ''

function addServer(): void {
  const s = defaultServer()
  appConfig.mcp.servers.push(s)
  editingId.value = s.id
  initialSnapshot = JSON.stringify(appConfig.mcp)
  // 新建服务器：传输方式可自由选（SSE / HTTP）。
  isNewServer.value = true
}

function startEdit(s: McpServerConfig): void {
  editingId.value = s.id
  initialSnapshot = JSON.stringify(appConfig.mcp)
  // 已保存过的服务器：传输方式即协议，固定不可改。
  isNewServer.value = false
}

/** 删除服务器：从列表移除并立即持久化，否则刷新后会从本地存储重新读回来。 */
function removeServer(s: McpServerConfig): void {
  uni.showModal({
    title: t('settings.mcp.remove'),
    content: t('settings.mcp.removeConfirm'),
    success: (res) => {
      if (!res.confirm) return
      const idx = appConfig.mcp.servers.findIndex((x) => x.id === s.id)
      if (idx < 0) return
      appConfig.mcp.servers.splice(idx, 1)
      if (editingId.value === s.id) editingId.value = null
      persistConfig()
    },
  })
}

/** 列表视图里直接开关启用/禁用，立即持久化。 */
function onToggleEnabled(s: McpServerConfig, val: boolean): void {
  s.enabled = val
  persistConfig()
}

/** 切换传输方式：切到 sse/http 时清掉 stdio 专属字段，避免残留下发网关。 */
function setTransport(s: McpServerConfig, value: McpTransport): void {
  s.transport = value
  if (value !== 'stdio') {
    s.command = undefined
    s.args = undefined
    s.env = undefined
  }
}

/** 请求头表格编辑：本地行列表，保存时写回 s.headers（避免直接改对象 key 的响应问题）。 */
interface HeaderRow { key: string; value: string }
const headerRows = ref<HeaderRow[]>([])
watch(
  () => editingId.value,
  () => {
    const s = editing.value
    headerRows.value = s
      ? Object.entries(s.headers ?? {}).map(([key, value]) => ({ key, value }))
      : []
  },
  { immediate: true },
)
function addHeaderRow(): void {
  headerRows.value.push({ key: '', value: '' })
}
function removeHeaderRow(idx: number): void {
  headerRows.value.splice(idx, 1)
}
function commitHeaders(): void {
  const s = editing.value
  if (!s) return
  const h: Record<string, string> = {}
  for (const r of headerRows.value) {
    const k = r.key.trim()
    if (k) h[k] = r.value
  }
  s.headers = Object.keys(h).length ? h : undefined
}

/** 必填校验：名称、服务器地址。不通过则提示并不落盘。 */
function validate(s: McpServerConfig): string | null {
  if (!s.name?.trim()) return t('settings.mcp.nameRequired')
  if (!s.url?.trim()) return t('settings.mcp.urlRequired')
  return null
}

async function saveEdit(): Promise<void> {
  if (saving.value) return
  const s = editing.value
  if (!s) return
  // 先把表格里的请求头写回配置，再做必填校验。
  commitHeaders()
  const err = validate(s)
  if (err) {
    uni.showToast({ title: err, icon: 'none' })
    return
  }
  saving.value = true
  try {
    // 整体持久化；保存后退出编辑，回到列表视图。
    persistConfig()
    await new Promise((r) => setTimeout(r, 300))
    editingId.value = null
    uni.showToast({ title: t('settings.mcp.saved'), icon: 'none' })
  } finally {
    saving.value = false
  }
}

/** 取消：还原本次编辑会话的快照，退出到列表，不落盘。 */
function cancelEdit(): void {
  if (initialSnapshot) {
    try {
      appConfig.mcp = JSON.parse(initialSnapshot)
    } catch {
      // 快照损坏则不动
    }
  }
  editingId.value = null
}

onMounted(() => {
  uni.setNavigationBarTitle({ title: t('settings.mcp.pageTitle') })
})

/** 返回：编辑态取消并退回列表；否则交给统一返回逻辑（无上一级则回设置页）。 */
const { goBack } = useSubPageBack({
  intercept: () => {
    if (isEditing.value) {
      cancelEdit()
      return true
    }
    return false
  },
})
</script>

<template>
  <view class="page" :style="themeStyle" :data-theme="dataTheme">
    <SubPageNav :title="t('settings.mcp.pageTitle')" @back="goBack" />

    <!-- 列表态（非编辑）：标题下信息行 + 空状态提示 + 服务器列表 + 底部常驻添加入口 -->
    <view v-if="!isEditing">
      <!-- 对标「长期记忆」的 .head：左侧数量徽章，右侧「＋」添加（替代清空全部） -->
      <view class="head">
        <text v-if="servers.length" class="count">{{ t('settings.mcp.total', { n: servers.length }) }}</text>
        <text class="add-link" @tap="addServer">＋</text>
      </view>

      <view v-if="empty" class="list-empty">
        <text class="empty-hint-title">{{ t('settings.mcp.emptyTitle') }}</text>
        <text class="empty-hint-desc">{{ t('settings.mcp.emptyDesc') }}</text>
      </view>

      <view v-else class="list">
        <view v-for="s in servers" :key="s.id" class="list-row" :class="{ off: !s.enabled }">
          <view class="row-main">
            <text class="row-name">{{ s.name || t('settings.mcp.untitled') }}</text>
            <text class="row-transport">{{ t(`settings.mcp.transport.${s.transport}`) }}</text>
          </view>
          <view class="row-actions">
            <switch :checked="s.enabled" color="#6c8cff" @change="(e: any) => onToggleEnabled(s, e.detail.value)" />
            <view class="act act-edit" @tap="startEdit(s)" :aria-label="t('settings.mcp.edit')">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </view>
            <view class="act act-del" @tap="removeServer(s)" :aria-label="t('settings.mcp.remove')">
              <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </view>
          </view>
        </view>
      </view>
    </view>

    <!-- 编辑视图：单个服务器的完整表单，保存/取消回到列表 -->
    <view v-else-if="editing" class="edit">
      <text class="row-label">{{ t('settings.mcp.name') }}</text>
      <input class="input" v-model="editing!.name" :placeholder="t('settings.mcp.name')" />

      <!-- 传输方式：单选，仿 内置 / dashscope 的 radio 效果；已保存服务器锁定不可改 -->
      <text class="row-label">{{ t('settings.mcp.transport.title') }}</text>
      <view class="providers">
        <view
          v-for="tp in TRANSPORTS"
          :key="tp"
          class="provider"
          :class="{ active: editing!.transport === tp, locked: transportLocked }"
          @tap="transportLocked ? undefined : setTransport(editing!, tp)"
        >
          <view class="radio"><view v-if="editing!.transport === tp" class="radio-dot" /></view>
          <text class="provider-name">{{ t(`settings.mcp.transport.${tp}`) }}</text>
        </view>
      </view>
      <text v-if="transportLocked" class="lock-hint">{{ t('settings.mcp.transportLocked') }}</text>

      <text class="row-label">{{ t('settings.mcp.url') }}</text>
      <input class="input" v-model="editing!.url" :placeholder="t('settings.mcp.urlPlaceholder')" />

      <!-- 请求头：键值表格，每行一个，可增删（鉴权用，可选） -->
      <text class="row-label">{{ t('settings.mcp.headers') }}</text>
      <view class="kv-list">
        <view v-for="(row, idx) in headerRows" :key="idx" class="kv-row">
          <input class="kv-key" v-model="row.key" :placeholder="t('settings.mcp.headerKey')" />
          <text class="kv-sep">:</text>
          <input class="kv-val" v-model="row.value" :placeholder="t('settings.mcp.headerValue')" />
          <view class="kv-del" @tap="removeHeaderRow(idx)" :aria-label="t('settings.mcp.remove')">
            <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
            </svg>
          </view>
        </view>
      </view>
      <view v-if="headerRows.length === 0" class="kv-empty">{{ t('settings.mcp.headersEmpty') }}</view>
      <view class="add-row-mini" @tap="addHeaderRow">
        <view class="add-plus">＋</view>
        <text class="add-text">{{ t('settings.mcp.addHeader') }}</text>
      </view>
    </view>

    <!-- 底部操作栏：仅编辑态显示，保存（蓝，左） + 取消（红，右） -->
    <view v-if="isEditing" class="action-bar">
      <button class="btn-primary" :disabled="saving" @tap="saveEdit">{{ t('settings.mcp.save') }}</button>
      <button class="btn-secondary" @tap="cancelEdit">{{ t('settings.mcp.cancel') }}</button>
    </view>

    <view v-if="saving" class="save-mask">
      <view class="save-spinner" />
    </view>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 16px 16px calc(96px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 14px;
  background:
    radial-gradient(120% 50% at 50% 0%, var(--bg-glow), transparent 60%),
    var(--bg-base);
}

/* 标题下信息行：左侧数量徽章 + 右侧「＋」添加（对标长期记忆页 .head） */
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 2px 6px;
}

.count {
  font-size: 12px;
  color: var(--accent);
  background: rgba(var(--accent-rgb), 0.14);
  border-radius: 10px;
  padding: 1px 8px;
}

.add-link {
  margin-left: auto;
  font-size: 24px;
  line-height: 1;
  color: var(--accent);
  flex-shrink: 0;
}

/* 空状态：纯文字提示 */
.list-empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 4px;
}

.empty-hint-title {
  font-size: 14px;
  font-weight: 600;
  color: #e8eaf6;
}

.empty-hint-desc {
  font-size: 12.5px;
  line-height: 1.7;
  color: #8b93b8;
}

/* 服务器列表：每行一张卡片 */
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.list-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.list-row.off {
  opacity: 0.5;
}

.row-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.row-name {
  font-size: 14px;
  font-weight: 600;
  color: #e8eaf6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-transport {
  font-size: 11px;
  color: #6f7691;
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}

.act {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
}

.ico {
  width: 19px;
  height: 19px;
}

.act-edit {
  color: #8fb0ff;
}

.act-del {
  color: #ff8a8a;
}

/* 编辑视图内的表单 */
.edit {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 传输方式：3 选 1 单选，仿设置页 内置 / dashscope 的 radio 效果 */
.providers {
  display: flex;
  gap: 10px;
}

.provider {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.09);
}

.provider.active {
  border-color: rgba(var(--accent-rgb), 0.7);
  background: rgba(var(--accent-rgb), 0.14);
}

.radio {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid #6f7691;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.provider.active .radio {
  border-color: var(--accent);
}

.radio-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
}

.provider-name {
  font-size: 13px;
  color: #e8eaf6;
}

/* 已保存服务器：传输方式锁定，不可改（协议固定） */
.provider.locked {
  opacity: 0.5;
  pointer-events: none;
}

.lock-hint {
  font-size: 11px;
  color: #8b93b8;
  margin-top: -4px;
}

.row-label {
  font-size: 12px;
  color: #aeb6dd;
  margin-top: 2px;
}

.input {
  width: 100%;
  min-height: 40px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.09);
  color: #e8eaf6;
  font-size: 13px;
  box-sizing: border-box;
}

/* 请求头键值表格：每行 key : value + 删除 */
.kv-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kv-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.kv-key,
.kv-val {
  flex: 1;
  min-height: 38px;
  padding: 9px 11px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.09);
  color: #e8eaf6;
  font-size: 13px;
  box-sizing: border-box;
}

.kv-sep {
  flex-shrink: 0;
  font-size: 13px;
  color: #8b93b8;
}

.kv-del {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: #ff8a8a;
}

.kv-del .ico {
  width: 17px;
  height: 17px;
}

/* 空表格提示 */
.kv-empty {
  font-size: 12px;
  color: #8b93b8;
  padding: 2px 4px;
}

/* 底部「添加请求头」入口 */
.add-row-mini {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 2px;
}

.add-plus {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(var(--accent-rgb), 0.16);
  color: var(--accent);
  font-size: 15px;
  line-height: 20px;
  text-align: center;
  flex-shrink: 0;
}

.add-text {
  font-size: 13px;
  color: var(--accent);
}

/* 底部操作栏：固定，保存（蓝，左） + 取消（红，右），等宽 */
.action-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 12px;
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
  background: linear-gradient(to top, #0f1120 70%, rgba(15, 17, 32, 0));
  z-index: 50;
}

/* 主按钮（渐变蓝，保存） */
.btn-primary {
  flex: 1;
  height: 46px;
  line-height: 46px;
  padding: 0;
  border-radius: 23px;
  font-size: 15px;
  font-weight: 600;
  box-sizing: border-box;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border: none;
}

.btn-primary[disabled] {
  opacity: 0.5;
}

.btn-primary::after {
  border: none;
}

/* 次按钮：红色实心（取消），等宽同高 */
.btn-secondary {
  flex: 1;
  height: 46px;
  line-height: 46px;
  padding: 0;
  border-radius: 23px;
  font-size: 15px;
  font-weight: 600;
  box-sizing: border-box;
  color: #fff;
  background: linear-gradient(135deg, #ff5a5a, #ff7a6c);
  border: none;
}

.btn-secondary::after {
  border: none;
}

.save-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

/* 宽屏（平板 / 横屏）：底部操作栏跟随内容列居中（覆盖上面的 left/right:0） */
@media (min-width: 600px) {
  .action-bar {
    left: 50%;
    right: auto;
    transform: translateX(-50%);
    width: 680px;
    max-width: calc(100% - 32px);
  }
}

.save-spinner {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(255, 255, 255, 0.25);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: save-spin 0.8s linear infinite;
}

@keyframes save-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
