<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { readScreenInfo, type ScreenInfo } from '@/core/adaptation/screen'
import { useAssistant } from '@/features/assistant/useAssistant'

const {
  state,
  stateLabel,
  enabled,
  transcript,
  reply,
  isSpeaking,
  errorMessage,
  wakeSupported,
  wakeProviderName,
  enable,
  disable,
  wakeNow,
  interrupt,
} = useAssistant()

const screen = ref<ScreenInfo>(readScreenInfo())

const isActive = computed(() => state.value === 'listening' || state.value === 'confirming')

const hint = computed(() => {
  switch (state.value) {
    case 'idle':
      return '打开语音助手，开始待唤醒'
    case 'standby':
      return '说「小熊小熊」唤醒，或点一下中间的开始'
    case 'listening':
      return isSpeaking.value ? '助手正在回答，可随时打断' : '我在听，说完可以停一下'
    case 'confirming':
      return '还在吗？再不出声我就先退下了'
    case 'closing':
      return '本轮结束，马上回到待唤醒'
    default:
      return ''
  }
})

function onResize(): void {
  screen.value = readScreenInfo()
}

function openSettings(): void {
  uni.navigateTo({ url: '/pages/settings/settings' })
}

onMounted(() => {
  uni.onWindowResize(onResize)
})

onUnmounted(() => {
  uni.offWindowResize(onResize)
})

function onToggle(event: Event): void {
  const value = (event as unknown as { detail?: { value?: boolean } }).detail?.value
  if (typeof value !== 'boolean') return
  if (value) enable()
  else disable()
}

function onOrbTap(): void {
  if (state.value === 'idle') {
    enable()
    return
  }
  if (state.value === 'standby') {
    wakeNow()
  }
}
</script>

<template>
  <view class="page" :class="`bp-${screen.breakpoint}`">
    <view class="header">
      <view class="brand">
        <text class="title">语音助手</text>
        <text class="subtitle">唤醒 · 对话 · 静默退出</text>
      </view>
      <view class="header-actions">
        <view class="pill" :class="state">{{ stateLabel }}</view>
        <view class="gear" @tap="openSettings">⚙</view>
      </view>
    </view>

    <view class="stage">
      <view
        class="orb"
        :class="{ active: isActive, speaking: isSpeaking }"
        @tap="onOrbTap"
      >
        <view class="orb-core">
          <text class="orb-icon">{{ isSpeaking ? '◍' : '◉' }}</text>
        </view>
      </view>
      <text class="hint">{{ hint }}</text>
      <text v-if="errorMessage" class="error">{{ errorMessage }}</text>
    </view>

    <view class="cards">
      <view class="card">
        <text class="card-label">你说</text>
        <text class="card-text">{{ transcript || '……' }}</text>
      </view>
      <view class="card reply">
        <text class="card-label">助手</text>
        <text class="card-text">{{ reply || '……' }}</text>
      </view>
    </view>

    <view class="controls">
      <view class="switch-row">
        <view class="switch-copy">
          <text class="switch-title">语音助手</text>
          <text class="switch-desc">关闭后释放麦克风</text>
        </view>
        <switch :checked="enabled" color="#6c8cff" @change="onToggle" />
      </view>

      <view class="buttons">
        <button class="btn ghost" :disabled="!enabled" @tap="wakeNow">唤醒</button>
        <button class="btn ghost" :disabled="!isActive" @tap="interrupt">打断</button>
      </view>
      <text v-if="isActive" class="talk-hint">正在听，直接说话即可（说完停顿一下）</text>
    </view>

    <view class="footer">
      <text>{{ screen.width }} × {{ screen.height }} · {{ screen.breakpoint }}</text>
      <text v-if="!wakeSupported">当前端无原生唤醒，按钮为模拟；App 端接原生 KWS</text>
      <text v-else>唤醒已就绪：{{ wakeProviderName }}</text>
    </view>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 24px 20px calc(24px + env(safe-area-inset-bottom));
  padding-top: calc(24px + env(safe-area-inset-top));
  display: flex;
  flex-direction: column;
  gap: 20px;
  background:
    radial-gradient(120% 60% at 50% 0%, rgba(108, 140, 255, 0.22), transparent 60%),
    #0f1220;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gear {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  color: #b8bdd4;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.brand {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.subtitle {
  font-size: 12px;
  color: #8b91ab;
}

.pill {
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #b8bdd4;
  background: rgba(255, 255, 255, 0.04);
}

.pill.listening,
.pill.confirming {
  color: #cfd8ff;
  border-color: rgba(108, 140, 255, 0.5);
  background: rgba(108, 140, 255, 0.16);
}

.stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 8px 0 4px;
}

.orb {
  width: 148px;
  height: 148px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 50% 35%, rgba(108, 140, 255, 0.5), rgba(108, 140, 255, 0.06) 65%);
  transition: transform 0.2s ease;
}

.orb.active {
  animation: pulse 2.4s ease-in-out infinite;
}

.orb.speaking {
  background: radial-gradient(circle at 50% 35%, rgba(92, 214, 178, 0.55), rgba(92, 214, 178, 0.08) 65%);
}

.orb-core {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 18, 32, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.orb-icon {
  font-size: 42px;
  color: #dfe5ff;
}

.hint {
  font-size: 13px;
  color: #9aa1bd;
  text-align: center;
}

.error {
  font-size: 12px;
  color: #ff9a9a;
}

.cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card {
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(255, 255, 255, 0.07);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 76px;
}

.card.reply {
  border-color: rgba(108, 140, 255, 0.28);
  background: rgba(108, 140, 255, 0.08);
}

.card-label {
  font-size: 11px;
  color: #8b91ab;
  letter-spacing: 1px;
}

.card-text {
  font-size: 14px;
  line-height: 1.6;
  color: #e8eaf6;
  word-break: break-word;
}

.controls {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.switch-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.switch-title {
  font-size: 15px;
  font-weight: 600;
}

.switch-desc {
  font-size: 11px;
  color: #8b91ab;
}

.buttons {
  display: flex;
  gap: 10px;
}

.btn {
  flex: 1;
  margin: 0;
  padding: 0 8px;
  height: 44px;
  line-height: 44px;
  border-radius: 12px;
  font-size: 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.05);
  color: #e8eaf6;
}

.btn::after {
  border: none;
}

.btn.primary {
  background: linear-gradient(135deg, #6c8cff, #8a6cff);
  border-color: transparent;
  color: #fff;
}

.btn[disabled] {
  opacity: 0.35;
}

.talk-hint {
  font-size: 11px;
  color: #8b91ab;
  text-align: center;
}

.footer {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  font-size: 11px;
  color: #6f7691;
  text-align: center;
}

/* 平板与折叠屏展开态：内容限宽，布局更舒展 */
.page.bp-medium,
.page.bp-expanded {
  max-width: 720px;
  margin: 0 auto;
}

.page.bp-expanded .cards {
  flex-direction: row;
}

.page.bp-expanded .card {
  flex: 1;
}

@keyframes pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.9;
  }
  50% {
    transform: scale(1.06);
    opacity: 1;
  }
}
</style>
