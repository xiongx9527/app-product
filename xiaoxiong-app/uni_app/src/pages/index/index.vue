<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { readScreenInfo, type ScreenInfo } from '@/core/adaptation/screen'
import { useAssistant } from '@/features/assistant/useAssistant'
import { toDisplayText } from '@/core/text/displayText'
import { toReplyHtml } from '@/core/text/replyHtml'
import {
  elapsedLabel,
  isSeekable,
  progressPercent,
  seekSeconds,
  totalLabel,
} from '@/core/audio/musicProgress'
import { t } from '@/core/i18n'

const {
  state,
  stateLabel,
  enabled,
  transcript,
  reply,
  thinking,
  thinkingDone,
  replyDone,
  phase,
  phaseLabel,
  isSpeaking,
  halfDuplex,
  queuePending,
  queueFullMsg,
  liveText,
  errorMessage,
  wakeSupported,
  wakeProviderName,
  enable,
  disable,
  interrupt,
  musicPlaying,
  musicPaused,
  musicError,
  musicVisible,
  musicTitle,
  musicCurrent,
  musicDuration,
  musicLive,
  lyrics,
  stopMusic,
  pauseMusic,
  resumeMusic,
  nextMusic,
  seekMusic,
  closeLyrics,
} = useAssistant()

const screen = ref<ScreenInfo>(readScreenInfo())

const isActive = computed(() => state.value === 'listening' || state.value === 'confirming')
// 模型回复可能是 Markdown 或 HTML，统一转成 rich-text 能渲染的安全 HTML
const replyHtml = computed(() => toReplyHtml(reply.value))
// 思考过程会很长，界面只留最近一段，避免卡片被撑爆
const thinkingTail = computed(() => {
  const text = toDisplayText(thinking.value)
  return text.length > 240 ? `…${text.slice(-240)}` : text
})

// 拖动进度条时先用手指位置显示，松手才真正 seek，避免 timeupdate 把滑块拽回去
const seekPreview = ref<number | null>(null)
const musicProgress = computed(() => ({
  currentTime: musicCurrent.value,
  duration: musicDuration.value,
  live: musicLive.value,
}))
const musicSeekable = computed(() => isSeekable(musicProgress.value))
const musicPercent = computed(() => progressPercent(musicProgress.value, seekPreview.value))
const musicElapsed = computed(() => elapsedLabel(musicProgress.value, seekPreview.value))
const musicTotal = computed(() => totalLabel(musicProgress.value))

function readSliderValue(event: unknown): number {
  const detail = (event as { detail?: { value?: unknown } } | null)?.detail
  const value = Number(detail?.value)
  return Number.isFinite(value) ? value : 0
}

function onSeekPreview(event: unknown): void {
  if (!musicSeekable.value) return
  seekPreview.value = seekSeconds(readSliderValue(event), musicDuration.value)
}

function onSeekCommit(event: unknown): void {
  if (!musicSeekable.value) return
  seekMusic(seekSeconds(readSliderValue(event), musicDuration.value))
  seekPreview.value = null
}

function onStopMusic(): void {
  seekPreview.value = null
  stopMusic()
}

function onTogglePause(): void {
  seekPreview.value = null
  if (musicPaused.value) resumeMusic()
  else pauseMusic()
}

function onNextMusic(): void {
  seekPreview.value = null
  nextMusic()
}

const hint = computed(() => {
  // 静默提示与退出优先，其余按对话阶段说明「现在在干嘛」，免得用户以为卡住
  if (state.value === 'confirming') return t('hint.confirming')
  if (state.value === 'closing') return t('hint.closing')
  switch (phase.value) {
    case 'listening':
      return t('hint.listening')
    case 'thinking':
      return t('hint.thinking')
    case 'replying':
      return t('hint.replying')
    case 'speaking':
      return halfDuplex.value ? t('hint.speakingHalf') : t('hint.speakingFull')
    case 'done':
      return t('hint.done')
    default:
      return state.value === 'idle' ? t('hint.idle') : t('hint.standby')
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
  // 只负责开启/关闭；唤醒靠语音「小熊小熊」，不做手动唤醒
  if (state.value === 'idle') enable()
}
</script>

<template>
  <view class="page" :class="`bp-${screen.breakpoint}`">
    <view class="header">
      <view class="brand">
        <text class="title">{{ t('app.title') }}</text>
        <text class="subtitle">{{ t('app.subtitle') }}</text>
      </view>
      <view class="header-actions">
        <view class="pill" :class="state">{{ stateLabel }}</view>
        <view class="gear" @tap="openSettings">⚙</view>
      </view>
    </view>

    <view v-if="queueFullMsg" class="queue-full-banner">{{ queueFullMsg }}</view>

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
      <text class="phase" :class="phase">{{ phaseLabel }}</text>
      <text v-if="liveText" class="live-text">{{ liveText }}</text>
      <text v-if="errorMessage" class="error">{{ errorMessage }}</text>
    </view>

    <view class="cards">
      <view class="card">
        <view class="card-head">
          <text class="card-label">{{ t('card.you') }}</text>
          <text v-if="queuePending > 0" class="queue-badge">{{ t('queue.badge', { count: queuePending }) }}</text>
        </view>
        <text class="card-text">{{ transcript || t('card.placeholder') }}</text>
      </view>
      <view v-if="thinking && !thinkingDone && !reply" class="card thinking">
        <view class="card-head">
          <text class="card-label">{{ t('card.thinking') }}</text>
          <text class="card-badge" :class="{ done: thinkingDone }">
            {{ thinkingDone ? t('card.done') : t('card.thinkingBadge') }}
          </text>
        </view>
        <text class="card-text thinking-text">{{ thinkingTail }}</text>
      </view>
      <view v-if="reply" class="card reply">
        <view class="card-head">
          <text class="card-label">{{ t('card.assistant') }}</text>
          <text class="card-badge" :class="{ done: replyDone }">
            {{ replyDone ? t('card.done') : t('card.generating') }}
          </text>
        </view>
        <rich-text class="card-text reply-rich" :nodes="replyHtml" />
      </view>
    </view>

    <view v-if="musicVisible" class="music-bar">
      <view class="music-row">
        <view class="music-info">
          <text class="music-label">{{ t('music.nowPlaying') }}</text>
          <text class="music-title">{{ musicTitle }}</text>
        </view>
        <view class="music-actions">
          <view class="music-ctrl primary" @tap="onNextMusic">{{ t('music.next') }}</view>
          <view class="music-ctrl" @tap="onTogglePause">{{ musicPaused ? t('music.resume') : t('music.pause') }}</view>
          <view class="music-ctrl" @tap="onStopMusic">{{ t('music.stop') }}</view>
        </view>
      </view>
      <text v-if="musicError" class="music-error">{{ t('music.error') }}</text>
      <view class="music-progress">
        <text class="music-time">{{ musicElapsed }}</text>
        <slider
          v-if="musicSeekable"
          class="music-slider"
          :value="musicPercent"
          :max="100"
          activeColor="#5cd6b2"
          backgroundColor="rgba(255, 255, 255, 0.14)"
          block-size="10"
          @changing="onSeekPreview"
          @change="onSeekCommit"
        />
        <view v-else class="music-live">
          <view class="music-live-dot" />
          <text class="music-live-text">{{ t('music.live') }}</text>
        </view>
        <text v-if="musicSeekable" class="music-time">{{ musicTotal }}</text>
      </view>
    </view>

    <view v-if="lyrics" class="lyrics">
      <view class="lyrics-head">
        <text class="lyrics-title">{{ t('music.lyrics') }} · {{ lyrics.title }}</text>
        <text class="lyrics-close" @tap="closeLyrics">{{ t('music.close') }}</text>
      </view>
      <text v-if="lyrics.artist" class="lyrics-artist">{{ lyrics.artist }}</text>
      <text class="lyrics-body">{{ lyrics.lyrics || t('music.noLyrics') }}</text>
    </view>

    <view class="controls">
      <view class="switch-row">
        <view class="switch-copy">
          <text class="switch-title">{{ t('switch.title') }}</text>
          <text class="switch-desc">{{ t('switch.desc') }}</text>
        </view>
        <switch :checked="enabled" color="#6c8cff" @change="onToggle" />
      </view>

      <view class="buttons">
        <button class="btn ghost" :disabled="!isActive" @tap="interrupt">{{ t('btn.interrupt') }}</button>
      </view>
      <text v-if="state === 'standby'" class="talk-hint">{{ t('talk.standby') }}</text>
      <text v-else-if="halfDuplex" class="talk-hint warn">
        {{ t('talk.echo') }}
      </text>
      <text v-else-if="isActive" class="talk-hint">{{ t('talk.listening') }}</text>
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

.phase {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  color: #8b91ab;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.phase.listening {
  color: #9fd8ff;
  border-color: rgba(108, 168, 255, 0.45);
}

.phase.thinking {
  color: #c9b8ff;
  border-color: rgba(150, 120, 255, 0.45);
}

.phase.replying {
  color: #cfd8ff;
  border-color: rgba(108, 140, 255, 0.5);
}

.phase.speaking {
  color: #8ee0bd;
  border-color: rgba(92, 214, 178, 0.45);
}

.phase.done {
  color: #8b91ab;
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

.card.thinking {
  background: rgba(255, 255, 255, 0.025);
  border-style: dashed;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-badge {
  font-size: 10px;
  color: #8f9bd6;
}

.card-badge.done {
  color: #6f7691;
}

.queue-badge {
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 10px;
  line-height: 1.6;
  color: #fff;
  background: #e5484d;
}

.queue-full-banner {
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  text-align: center;
  color: #fff;
  background: linear-gradient(135deg, #e5484d, #f0743f);
  box-shadow: 0 4px 16px rgba(229, 72, 77, 0.28);
}

.live-text {
  font-size: 14px;
  line-height: 1.6;
  color: #c7cde6;
  text-align: center;
  min-height: 20px;
  word-break: break-word;
}

.thinking-text {
  font-size: 12px;
  line-height: 1.7;
  color: #9aa1bd;
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

.talk-hint.warn {
  color: #ffcf8a;
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

.music-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(92, 214, 178, 0.08);
  border: 1px solid rgba(92, 214, 178, 0.28);
}

.music-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.music-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.music-ctrl {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  line-height: 1;
  color: #e8eaf6;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14);
  transition: transform 0.12s ease, background 0.12s ease;
}

.music-ctrl.primary {
  background: rgba(92, 214, 178, 0.18);
  border-color: rgba(92, 214, 178, 0.42);
  color: #8ee0bd;
}

.music-ctrl:active {
  transform: scale(0.9);
}

.music-error {
  font-size: 11px;
  color: #ffb38a;
}

.music-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.music-time {
  font-size: 11px;
  color: #8ee0bd;
  min-width: 30px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.music-slider {
  flex: 1;
  margin: 0;
}

.music-live {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
}

.music-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5cd6b2;
}

.music-live-text {
  font-size: 11px;
  letter-spacing: 1px;
  color: #8ee0bd;
}

.music-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.music-label {
  font-size: 10px;
  letter-spacing: 1px;
  color: #8ee0bd;
}

.music-title {
  font-size: 14px;
  color: #e8eaf6;
  word-break: break-word;
}

.lyrics {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 14px;
  background: rgba(108, 140, 255, 0.07);
  border: 1px solid rgba(108, 140, 255, 0.22);
}

.lyrics-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.lyrics-title {
  font-size: 12px;
  color: #cfd8ff;
  word-break: break-word;
}

.lyrics-close {
  font-size: 12px;
  color: #8b91ab;
}

.lyrics-artist {
  font-size: 11px;
  color: #8b91ab;
}

.lyrics-body {
  font-size: 13px;
  line-height: 1.7;
  color: #dfe5ff;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
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
