<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { appConfig, persistConfig } from '@/core/config'
import type { McpServerConfig, McpTransport } from '@/core/config/types'
import { t } from '@/core/i18n'

const TRANSPORTS: McpTransport[] = ['stdio', 'sse', 'http']

/** 生成本地稳定 id（仅列表 key 与持久化用，不下发网关）。 */
function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function defaultServer(): McpServerConfig {
  return { id: newId(), name: '', enabled: true, transport: 'stdio', command: '' }
}

const servers = computed(() => appConfig.mcp.servers)
const empty = computed(() => servers.value.length === 0)
const saving = ref(false)

function addServer(): void {
  appConfig.mcp.servers.push(defaultServer())
}

function removeServer(s: McpServerConfig): void {
  uni.showModal({
    title: t('settings.mcp.remove'),
    content: t('settings.mcp.removeConfirm'),
    success: (res) => {
      if (!res.confirm) return
      const idx = appConfig.mcp.servers.findIndex((x) => x.id === s.id)
      if (idx >= 0) appConfig.mcp.servers.splice(idx, 1)
    },
  })
}

/** 切换传输方式：stdio 清空 url、sse/http 清空 command/args/env，避免残留非法字段。 */
function setTransport(s: McpServerConfig, value: McpTransport): void {
  s.transport = value
  if (value === 'stdio') {
    s.url = undefined
    s.enabledTools = undefined
    s.disabledTools = undefined
  } else {
    s.command = undefined
    s.args = undefined
    s.env = undefined
  }
}

/** args 以逗号分隔的文本编辑：双向转换为数组。 */
function argsText(s: McpServerConfig): string {
  return (s.args ?? []).join(', ')
}
function onArgsInput(s: McpServerConfig, val: string): void {
  const arr = val
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  s.args = arr.length ? arr : undefined
}

/** enabledTools / disabledTools 同样以逗号分隔编辑。 */
function toolsText(list?: string[]): string {
  return (list ?? []).join(', ')
}
function onToolsInput(s: McpServerConfig, key: 'enabledTools' | 'disabledTools', val: string): void {
  const arr = val.split(',').map((x) => x.trim()).filter(Boolean)
  s[key] = arr.length ? arr : undefined
}

/** env 以「KEY=VALUE」每行一条编辑。 */
function envText(s: McpServerConfig): string {
  const e = s.env ?? {}
  return Object.entries(e).map(([k, v]) => `${k}=${v}`).join('\n')
}
function onEnvInput(s: McpServerConfig, val: string): void {
  const e: Record<string, string> = {}
  for (const line of val.split('\n')) {
    const i = line.indexOf('=')
    if (i <= 0) continue
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim()
    if (k) e[k] = v
  }
  s.env = Object.keys(e).length ? e : undefined
}

async function onSave(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    // 仅启用项随 session.start 下发；这里直接整体持久化，禁用项也保留在列表里供下次开启。
    persistConfig()
    await new Promise((r) => setTimeout(r, 300))
    uni.navigateBack()
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  uni.setNavigationBarTitle({ title: t('settings.mcp.title') })
})
</script>

<template>
  <view class="page">
    <text class="sub">{{ t('settings.mcp.sub') }}</text>

    <text v-if="empty" class="hint empty">{{ t('settings.mcp.empty') }}</text>

    <view v-for="s in servers" :key="s.id" class="card">
      <view class="card-head">
        <input class="name-input" v-model="s.name" :placeholder="t('settings.mcp.name')" />
        <switch :checked="s.enabled" color="#6c8cff" @change="(e: any) => (s.enabled = e.detail.value)" />
        <text class="del" @tap="removeServer(s)">{{ t('settings.mcp.remove') }}</text>
      </view>

      <!-- 传输方式单选 -->
      <view class="transports">
        <view
          v-for="tp in TRANSPORTS"
          :key="tp"
          class="transport"
          :class="{ active: s.transport === tp }"
          @tap="setTransport(s, tp)"
        >
          <view class="radio"><view v-if="s.transport === tp" class="radio-dot" /></view>
          <text class="transport-name">{{ t(`settings.mcp.transport.${tp}`) }}</text>
        </view>
      </view>

      <!-- stdio：命令 + 参数 + 环境变量 -->
      <template v-if="s.transport === 'stdio'">
        <text class="row-label">{{ t('settings.mcp.command') }}</text>
        <input class="input" v-model="s.command" placeholder="npx @modelcontextprotocol/server-filesystem" />
        <text class="row-label">{{ t('settings.mcp.args') }}</text>
        <input class="input" :value="argsText(s)" @input="(e: any) => onArgsInput(s, e.detail.value)" placeholder="--help" />
        <text class="row-label">{{ t('settings.mcp.env') }}</text>
        <textarea class="env" :value="envText(s)" @input="(e: any) => onEnvInput(s, e.detail.value)" :placeholder="'KEY=VALUE\nPATH=/tmp'" />
      </template>

      <!-- sse / http：地址 -->
      <template v-else>
        <text class="row-label">{{ t('settings.mcp.url') }}</text>
        <input class="input" v-model="s.url" placeholder="http://localhost:3000/mcp" />
      </template>

      <!-- 工具白/黑名单（可选） -->
      <text class="row-label">{{ t('settings.mcp.enabledTools') }}</text>
      <input class="input" :value="toolsText(s.enabledTools)" @input="(e: any) => onToolsInput(s, 'enabledTools', e.detail.value)" :placeholder="t('settings.mcp.toolsPlaceholder')" />
      <text class="row-label">{{ t('settings.mcp.disabledTools') }}</text>
      <input class="input" :value="toolsText(s.disabledTools)" @input="(e: any) => onToolsInput(s, 'disabledTools', e.detail.value)" :placeholder="t('settings.mcp.toolsPlaceholder')" />
    </view>

    <button class="add" @tap="addServer">+ {{ t('settings.mcp.add') }}</button>
    <button class="save" :disabled="saving" @tap="onSave">{{ t('settings.save') }}</button>

    <view v-if="saving" class="save-mask">
      <view class="save-spinner" />
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
    radial-gradient(120% 50% at 50% 0%, rgba(108, 140, 255, 0.18), transparent 60%),
    #0f1220;
}

.sub {
  font-size: 12px;
  line-height: 1.6;
  color: #6f7691;
}

.hint {
  font-size: 13px;
  line-height: 1.6;
  color: #6f7691;
  padding: 24px 4px;
}

.empty {
  text-align: center;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.name-input {
  flex: 1;
  min-height: 36px;
  padding: 0 10px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #e8eaf6;
  font-size: 13px;
  box-sizing: border-box;
}

.del {
  font-size: 12px;
  color: #ff8a8a;
  flex-shrink: 0;
}

.transports {
  display: flex;
  gap: 10px;
}

.transport {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.transport.active {
  border-color: rgba(108, 140, 255, 0.6);
  background: rgba(108, 140, 255, 0.12);
}

.radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid #6f7691;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.transport.active .radio {
  border-color: #6c8cff;
}

.radio-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #6c8cff;
}

.transport-name {
  font-size: 12px;
  color: #e8eaf6;
}

.row-label {
  font-size: 12px;
  color: #cfd8ff;
}

.input {
  width: 100%;
  min-height: 38px;
  padding: 9px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #e8eaf6;
  font-size: 13px;
  box-sizing: border-box;
}

.env {
  width: 100%;
  min-height: 70px;
  padding: 9px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #e8eaf6;
  font-size: 13px;
  box-sizing: border-box;
}

.add {
  align-self: stretch;
  height: 42px;
  line-height: 42px;
  padding: 0;
  border-radius: 21px;
  font-size: 14px;
  font-weight: 600;
  color: #cfd8ff;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.add::after {
  border: none;
}

.save {
  align-self: stretch;
  width: 100%;
  height: 44px;
  line-height: 44px;
  padding: 0;
  border-radius: 22px;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #6c8cff, #8a6cff);
  border: none;
}

.save::after {
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

.save-spinner {
  width: 34px;
  height: 34px;
  border: 3px solid rgba(255, 255, 255, 0.25);
  border-top-color: #6c8cff;
  border-radius: 50%;
  animation: save-spin 0.8s linear infinite;
}

@keyframes save-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
