<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '@/core/i18n'
import { fetchGatewayMcpTools, type GatewayMcpTool } from '@/core/transport/gatewayControl'
import { useSubPageBack } from '@/core/composables/useSubPageBack'
import SubPageNav from '@/components/SubPageNav.vue'
import { useThemeStyle } from '@/core/composables/useTheme'

/**
 * MCP 已注册工具列表：展示网关从固定对接的 MCP server 发现到的工具（名 + 说明）。
 * 只读展示，不在这里调用工具——工具由助手在对话里按语义自主触发。
 */
const { themeStyle, dataTheme } = useThemeStyle()
const { goBack } = useSubPageBack({ fallbackUrl: '/pages/settings/settings' })

const loading = ref(true)
const tools = ref<GatewayMcpTool[]>([])
const error = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  const res = await fetchGatewayMcpTools()
  tools.value = res.tools
  if (!res.ok) error.value = res.error || t('settings.mcp.toolsFail')
  loading.value = false
}

onMounted(() => { void load() })
</script>

<template>
  <view class="page" :style="themeStyle" :data-theme="dataTheme">
    <SubPageNav :title="t('settings.mcp.toolsTitle')" @back="goBack" />

    <view class="head">
      <text class="sub">{{ t('settings.mcp.toolsSub') }}</text>
      <text class="refresh" @tap="load">{{ t('settings.mcp.toolsRefresh') }}</text>
    </view>

    <text v-if="loading" class="state">{{ t('settings.mcp.toolsLoading') }}</text>
    <text v-else-if="error" class="state state-err">{{ error }}</text>
    <text v-else-if="!tools.length" class="state">{{ t('settings.mcp.toolsEmpty') }}</text>

    <view v-else class="list">
      <view v-for="tool in tools" :key="tool.name" class="tool">
        <text class="tool-name">{{ tool.name }}</text>
        <text v-if="tool.description" class="tool-desc">{{ tool.description }}</text>
      </view>
      <text class="count">{{ t('settings.mcp.toolsCount', { n: tools.length }) }}</text>
    </view>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 0 16px calc(32px + env(safe-area-inset-bottom));
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
  justify-content: space-between;
  gap: 10px;
}
.sub {
  font-size: 12px;
  line-height: 1.5;
  color: #6f7691;
  flex: 1;
}
.refresh {
  font-size: 13px;
  color: var(--accent);
  flex-shrink: 0;
}
.state {
  font-size: 13px;
  line-height: 1.6;
  color: #9aa0bd;
  padding: 24px 4px;
}
.state-err {
  color: #ff8a8a;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tool {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.tool-name {
  font-size: 13px;
  color: #9be8cd;
  word-break: break-all;
}
.tool-desc {
  font-size: 12px;
  line-height: 1.5;
  color: #9aa0bd;
}
.count {
  font-size: 12px;
  color: #6f7691;
  text-align: center;
  padding: 4px 0;
}
</style>
