<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  appConfig,
  languageLabel,
  persistConfig,
  resetVoice,
  setVoiceProvider,
} from '@/core/config'
import { DEFAULT_DASHSCOPE_URL } from '@/core/config/constants'
import { t } from '@/core/i18n'
import { secureRequest } from '@/core/transport/secureRequest'
import { resolveGatewayHttpBase } from '@/core/transport/webSocketTransport'
import { getDeviceId } from '@/core/config/deviceId'

/** 语音服务来源：内置 / DashScope，二者都只填 url + apiKey；内置默认勾选 */

const languageIndex = computed(() =>
  Math.max(
    0,
    LANGUAGE_OPTIONS.findIndex((item) => item.value === appConfig.language)
  )
)
const languageLabels = LANGUAGE_OPTIONS.map((item) => item.label)
function onLanguageChange(event: Event): void {
  const value = (event as unknown as { detail?: { value?: number } }).detail?.value
  const option = typeof value === 'number' ? LANGUAGE_OPTIONS[value] : undefined
  if (option) appConfig.language = option.value
}

const timezoneIndex = computed(() =>
  Math.max(
    0,
    TIMEZONE_OPTIONS.findIndex((item) => item.value === appConfig.timezone)
  )
)
const timezoneLabels = TIMEZONE_OPTIONS.map((item) => item.label)
function onTimezoneChange(event: Event): void {
  const value = (event as unknown as { detail?: { value?: number } }).detail?.value
  const option = typeof value === 'number' ? TIMEZONE_OPTIONS[value] : undefined
  if (option) appConfig.timezone = option.value
}

const saveHint = ref('')

/** DashScope 的地址固定默认（用户不填），仅只读展示；内置则回退到本地 9529 默认。 */
const voiceAddressDisplay = computed(() => appConfig.voice.url.trim() || DEFAULT_DASHSCOPE_URL)

function onSave(): void {
  persistConfig()
  saveHint.value = t('settings.savedNext')
}

function onResetVoice(): void {
  resetVoice()
  saveHint.value = t('settings.savedNext')
}

/** 长期记忆：从网关按本机 deviceId 拉取，可单条删除或清空。 */
interface MemoryItem {
  key: string
  value: string
  updatedAt: number
}
const memories = ref<MemoryItem[]>([])
const memLoading = ref(false)
const memHint = ref('')

function gatewayMemoriesUrl(): string {
  return `${resolveGatewayHttpBase()}/api/assistant/memories?deviceId=${encodeURIComponent(getDeviceId())}`
}

async function loadMemories(): Promise<void> {
  if (memLoading.value) return
  memLoading.value = true
  memHint.value = ''
  try {
    const res = await secureRequest({ url: gatewayMemoriesUrl(), method: 'GET' })
    if (res.statusCode >= 200 && res.statusCode < 300 && Array.isArray(res.data)) {
      memories.value = res.data as MemoryItem[]
    } else {
      memHint.value = t('settings.memory.loadFailed')
    }
  } catch {
    memHint.value = t('settings.memory.loadFailed')
  } finally {
    memLoading.value = false
  }
}

async function deleteMemory(item: MemoryItem): Promise<void> {
  try {
    const res = await secureRequest({
      url: `${gatewayMemoriesUrl()}&key=${encodeURIComponent(item.key)}`,
      method: 'DELETE',
    })
    if (res.statusCode >= 200 && res.statusCode < 300) {
      memories.value = memories.value.filter((m) => m.key !== item.key)
      memHint.value = t('settings.memory.deleted')
    }
  } catch {
    memHint.value = t('settings.memory.loadFailed')
  }
}

async function clearMemories(): Promise<void> {
  try {
    const res = await secureRequest({ url: gatewayMemoriesUrl(), method: 'DELETE' })
    if (res.statusCode >= 200 && res.statusCode < 300) {
      memories.value = []
      memHint.value = t('settings.memory.cleared')
    }
  } catch {
    memHint.value = t('settings.memory.loadFailed')
  }
}

onMounted(() => {
  void loadMemories()
})
</script>

<template>
  <view class="page">
    <text class="notice">{{ t('settings.notice.title') }}：{{ t('settings.notice.text') }}</text>

    <!-- 语音服务（ASR / LLM / TTS 共用一份配置） -->
    <view class="group">
      <text class="group-title">{{ t('settings.voice.title') }}</text>

      <text class="row-label">{{ t('settings.voice.provider') }}</text>
      <view class="providers">
        <view
          class="provider"
          :class="{ active: appConfig.voice.provider === 'builtin' }"
          @tap="setVoiceProvider('builtin')"
        >
          <view class="radio"><view v-if="appConfig.voice.provider === 'builtin'" class="radio-dot" /></view>
          <text class="provider-name">{{ t('settings.voice.builtin') }}</text>
        </view>
        <view
          class="provider"
          :class="{ active: appConfig.voice.provider === 'dashscope' }"
          @tap="setVoiceProvider('dashscope')"
        >
          <view class="radio"><view v-if="appConfig.voice.provider === 'dashscope'" class="radio-dot" /></view>
          <text class="provider-name">{{ t('settings.voice.dashscope') }}</text>
        </view>
      </view>

      <!-- 内置：地址 + 密钥都可编辑 -->
      <view v-if="appConfig.voice.provider === 'builtin'" class="row column">
        <text class="row-label">{{ t('settings.voice.url') }}</text>
        <input
          class="input"
          v-model="appConfig.voice.url"
          placeholder="http://127.0.0.1:9529"
        />
        <text class="hint">{{ t('settings.voice.urlBuiltinHint') }}</text>
      </view>

      <!-- 百炼：地址固定默认，只读展示；只填密钥 -->
      <view v-else class="row column">
        <text class="row-label">{{ t('settings.voice.url') }}</text>
        <input class="input" :disabled="true" :value="voiceAddressDisplay" />
        <text class="hint">{{ t('settings.voice.urlDashscopeHint') }}</text>
      </view>

      <view class="row column">
        <text class="row-label">{{ t('settings.voice.apiKey') }}</text>
        <input
          class="input"
          :password="true"
          v-model="appConfig.voice.apiKey"
          :placeholder="t('settings.voice.apiKeyHint')"
        />
      </view>

      <button class="reset" @tap="onResetVoice">{{ t('settings.reset') }}</button>
    </view>

    <!-- 时区 -->
    <view class="group">
      <picker :range="timezoneLabels" :value="timezoneIndex" @change="onTimezoneChange">
        <view class="row">
          <view class="row-text">
            <text class="row-label">{{ t('settings.timezone.title') }}</text>
            <text class="hint">{{ t('settings.timezone.hint') }}</text>
          </view>
          <view class="row-right">
            <text class="row-value">{{ timezoneLabels[timezoneIndex] }}</text>
            <text class="arrow">›</text>
          </view>
        </view>
      </picker>
    </view>

    <!-- 语言 -->
    <view class="group">
      <picker :range="languageLabels" :value="languageIndex" @change="onLanguageChange">
        <view class="row">
          <view class="row-text">
            <text class="row-label">{{ t('settings.language.title') }}</text>
            <text class="hint">{{ t('settings.language.hint') }}</text>
          </view>
          <view class="row-right">
            <text class="row-value">{{ languageLabel(appConfig.language) }}</text>
            <text class="arrow">›</text>
          </view>
        </view>
      </picker>
    </view>

    <!-- 长期记忆 -->
    <view class="group">
      <view class="group-head">
        <text class="group-title">{{ t('settings.memory.title') }}</text>
        <view class="group-actions">
          <text class="link" :class="{ disabled: memLoading }" @tap="loadMemories">
            {{ memLoading ? '…' : t('settings.memory.refresh') }}
          </text>
          <text
            v-if="memories.length"
            class="link"
            :class="{ disabled: memLoading }"
            @tap="clearMemories"
          >
            {{ t('settings.memory.clearAll') }}
          </text>
        </view>
      </view>
      <text v-if="memHint" class="hint">{{ memHint }}</text>
      <text v-if="!memories.length && !memHint" class="hint">
        {{ t('settings.memory.empty') }}
      </text>
      <view v-for="item in memories" :key="item.key" class="memory-row">
        <view class="memory-text">
          <text class="memory-key">{{ item.key }}</text>
          <text class="memory-value">{{ item.value }}</text>
        </view>
        <text class="link" @tap="deleteMemory(item)">
          {{ t('settings.memory.delete') }}
        </text>
      </view>
    </view>

    <button class="save" @tap="onSave">{{ t('settings.save') }}</button>
    <text v-if="saveHint" class="save-hint">{{ saveHint }}</text>
    <text class="foot">{{ t('settings.foot') }}</text>
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

.notice {
  font-size: 12px;
  line-height: 1.6;
  color: #8fb6ab;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.group-title {
  font-size: 13px;
  font-weight: 600;
  color: #9be8cd;
}

.providers {
  display: flex;
  gap: 10px;
}

.provider {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.provider.active {
  border-color: rgba(108, 140, 255, 0.6);
  background: rgba(108, 140, 255, 0.12);
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
  border-color: #6c8cff;
}

.radio-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #6c8cff;
}

.provider-name {
  font-size: 13px;
  color: #e8eaf6;
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.group-actions {
  display: flex;
  gap: 14px;
}

.link {
  font-size: 12px;
  color: #6c8cff;
}

.link.disabled {
  opacity: 0.5;
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

.row.column {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.row-label {
  font-size: 13px;
  color: #e8eaf6;
}

.row-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row-value {
  font-size: 14px;
  color: #e8eaf6;
}

.arrow {
  font-size: 16px;
  color: #6f7691;
}

.input {
  width: 100%;
  min-height: 40px;
  padding: 9px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #e8eaf6;
  font-size: 13px;
  box-sizing: border-box;
}

.hint {
  font-size: 11px;
  line-height: 1.5;
  color: #6f7691;
}

.muted {
  font-size: 13px;
  color: #8b91ab;
}

.reset {
  align-self: flex-start;
  margin: 0;
  height: 34px;
  line-height: 34px;
  padding: 0 14px;
  border-radius: 10px;
  font-size: 12px;
  color: #b8bdd4;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.reset::after {
  border: none;
}

.memory-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.memory-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.memory-key {
  font-size: 12px;
  font-weight: 600;
  color: #cfd8ff;
}

.memory-value {
  font-size: 13px;
  line-height: 1.5;
  color: #e8eaf6;
  word-break: break-all;
}

.save {
  margin-top: 4px;
  height: 48px;
  line-height: 48px;
  border-radius: 14px;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, #6c8cff, #8a6cff);
  border: none;
}

.save::after {
  border: none;
}

.save-hint {
  font-size: 12px;
  color: #a8c0ff;
  text-align: center;
}

.foot {
  font-size: 11px;
  line-height: 1.6;
  color: #6f7691;
  text-align: center;
}
</style>
