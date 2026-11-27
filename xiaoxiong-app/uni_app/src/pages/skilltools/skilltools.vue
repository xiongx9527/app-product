<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { t } from '@/core/i18n'
import { fetchGatewaySkills, type GatewaySkill } from '@/core/transport/gatewayControl'
import { useSubPageBack } from '@/core/composables/useSubPageBack'
import SubPageNav from '@/components/SubPageNav.vue'
import { useThemeStyle } from '@/core/composables/useTheme'

/**
 * 已加载 Skill 列表：展示服务端（19529）下发、网关注入 systemPrompt 的 skill（名 + 说明 + 正文）。
 * 只读展示，点标题行展开看 markdown 正文（与 19529 管理页「预览正文」一致）。
 */
const { themeStyle, dataTheme } = useThemeStyle()
const { goBack } = useSubPageBack({ fallbackUrl: '/pages/settings/settings' })

const loading = ref(true)
const skills = ref<GatewaySkill[]>([])
const error = ref('')
const expanded = ref('')

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  const res = await fetchGatewaySkills()
  skills.value = res.skills
  if (!res.ok) error.value = res.error || t('settings.skill.loadFail')
  loading.value = false
}

function toggle(name: string): void {
  expanded.value = expanded.value === name ? '' : name
}

onMounted(() => { void load() })
</script>

<template>
  <view class="page" :style="themeStyle" :data-theme="dataTheme">
    <SubPageNav :title="t('settings.skill.listTitle')" @back="goBack" />

    <view class="head">
      <text class="sub">{{ t('settings.skill.toolsSub') }}</text>
      <text class="refresh" @tap="load">{{ t('settings.skill.refresh') }}</text>
    </view>

    <text v-if="loading" class="state">{{ t('settings.skill.loading') }}</text>
    <text v-else-if="error" class="state state-err">{{ error }}</text>
    <text v-else-if="!skills.length" class="state">{{ t('settings.skill.empty') }}</text>

    <view v-else class="list">
      <view v-for="s in skills" :key="s.name" class="skill">
        <view class="skill-head" @tap="toggle(s.name)">
          <text class="skill-name">{{ s.name }}</text>
          <text class="toggle">{{ expanded === s.name ? '▾' : '▸' }}</text>
        </view>
        <text v-if="s.description" class="skill-desc">{{ s.description }}</text>
        <text v-if="expanded === s.name" class="skill-content">{{ s.content || t('settings.skill.noContent') }}</text>
      </view>
      <text class="count">{{ t('settings.skill.count', { n: skills.length }) }}</text>
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
.head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.sub { font-size: 12px; line-height: 1.5; color: #6f7691; flex: 1; }
.refresh { font-size: 13px; color: var(--accent); flex-shrink: 0; }
.state { font-size: 13px; line-height: 1.6; color: #9aa0bd; padding: 24px 4px; }
.state-err { color: #ff8a8a; }
.list { display: flex; flex-direction: column; gap: 8px; }
.skill {
  display: flex; flex-direction: column; gap: 4px; padding: 10px 12px;
  border-radius: 12px; background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}
.skill-head { display: flex; flex-direction: row; align-items: center; justify-content: space-between; }
.skill-name { font-size: 13px; color: #9be8cd; word-break: break-all; }
.toggle { font-size: 12px; color: var(--accent); }
.skill-desc { font-size: 12px; line-height: 1.5; color: #9aa0bd; white-space: normal; word-break: break-all; }
/* 正文：多行完整显示 */
.skill-content {
  font-size: 11px; line-height: 1.6; color: #b9bed6; margin-top: 6px; padding: 8px;
  background: rgba(0, 0, 0, 0.2); border-radius: 6px; white-space: pre-wrap; word-break: break-word;
}
.count { font-size: 12px; color: #6f7691; text-align: center; padding: 4px 0; }
</style>
