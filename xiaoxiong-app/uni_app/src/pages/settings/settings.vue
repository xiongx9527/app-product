<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  appConfig,
  persistConfig,
  resetVoice,
  setVoiceProvider,
} from '@/core/config'
import type { PlaybackSource } from '@/core/config'
import { DEFAULT_DASHSCOPE_URL } from '@/core/config/constants'
import { t } from '@/core/i18n'
import { secureRequest } from '@/core/transport/secureRequest'
import { resolveGatewayHttpBase } from '@/core/transport/webSocketTransport'
import { getActiveTransport } from '@/core/transport'
import { getDeviceId } from '@/core/config/deviceId'
import SelectRow from '@/components/SelectRow.vue'

/** 时区下拉选项：值用 IANA 名，展示文案按当前语言本地化。 */
const timezoneOptions = computed(() =>
  TIMEZONE_OPTIONS.map((o) => ({ value: o.value, label: t(o.i18nKey) })),
)

/** 播放源下拉：当前仅百度，后续可扩展；文案按当前语言本地化。 */
const playbackSources = computed(() => [
  { value: 'baidu' as PlaybackSource, label: t('settings.playback.baidu') },
  { value: 'netease' as PlaybackSource, label: t('settings.playback.netease') },
  { value: 'tencent' as PlaybackSource, label: t('settings.playback.tencent') },
  { value: 'kugou' as PlaybackSource, label: t('settings.playback.kugou') },
])

const saving = ref(false)

async function onSave(): Promise<void> {
  saving.value = true
  try {
    persistConfig()
    // 设置页改了播放源：若语音会话仍连着，立即推给网关重建音乐源，无需重连/重唤醒即可生效；
    // 未连接时退化为「下一次唤醒随 session.start 生效」，不强行发（发了也没人收）。
    const transport = getActiveTransport()
    if (transport?.isConnected()) {
      transport.notifyPlaybackSource(appConfig.playback.source)
    }
    // 本地落盘是同步的，加一个最短可见时长让加载遮罩有反馈，而不是一闪而过。
    await new Promise((r) => setTimeout(r, 400))
  } finally {
    saving.value = false
  }
}

function onResetVoice(): void {
  resetVoice()
}

/** LLM 模型下拉：选项来自来源配置（内置=已配置上游模型；百炼=带 key 拉真实目录）。 */
const llmModels = ref<{ value: string; label: string }[]>([])
const llmModelHint = ref('')

function currentProviderSettings() {
  const v = appConfig.voice
  return v.provider === 'dashscope' ? v.dashscope : v.builtin
}

async function loadLlmModels(): Promise<void> {
  llmModelHint.value = ''
  const provider = appConfig.voice.provider
  const settings = currentProviderSettings()
  // 前端只与网关通信：模型列表由网关持有来源地址并中转拉取，前端只传 provider。
  // 仅百炼需要用户本机 api-key（密钥只落本机，必须由前端带来）；内置无需任何密钥。
  const qs = new URLSearchParams({ provider })
  // api-key 只落本机，必须由前端带来；内置非必填（可空），百炼必带。地址一律由网关持有中转，
  // 前端只传 provider + 可选 api-key，绝不直接指定来源地址。
  if (settings.apiKey) qs.set('apiKey', settings.apiKey)
  try {
    const res = await secureRequest({
      url: `${resolveGatewayHttpBase()}/api/admin/llm-models?${qs.toString()}`,
      method: 'GET',
    })
    const data = res.data as { models?: string[] } | null
    if (res.statusCode >= 200 && res.statusCode < 300 && data && Array.isArray(data.models) && data.models.length) {
      llmModels.value = data.models.map((m) => ({ value: m, label: m }))
      // 当前没选或选中的已不在列表里：自动选第一个，保证开箱即连得上（选项来自来源配置）。
      const settings = currentProviderSettings()
      if (!settings.model || !data.models.includes(settings.model)) {
        settings.model = data.models[0]
      }
    } else {
      llmModels.value = []
      llmModelHint.value = t('settings.voice.llmModelEmpty')
    }
  } catch {
    llmModels.value = []
    llmModelHint.value = t('settings.voice.llmModelFailed')
  }
}

function onSelectProvider(p: 'builtin' | 'dashscope'): void {
  setVoiceProvider(p)
  void loadLlmModels()
  void loadTtsVoices()
}

/** 音色下拉：选项来自网关的固定精选目录（内置=Edge-TTS 常用；百炼=官方 CosyVoice 标准），不实时拉取以便国际化。 */
const ttsVoices = ref<{ value: string; label: string }[]>([])
const ttsVoiceHint = ref('')

async function loadTtsVoices(): Promise<void> {
  ttsVoiceHint.value = ''
  const provider = appConfig.voice.provider
  // 前端只与网关通信：把 provider 与当前语言带给网关，由网关按 lang 拼出本地化标签。
  const qs = new URLSearchParams({ provider, lang: appConfig.language })
  try {
    const res = await secureRequest({
      url: `${resolveGatewayHttpBase()}/api/admin/tts-voices?${qs.toString()}`,
      method: 'GET',
    })
    const data = res.data as { defaultVoice?: string; voices?: { value: string; label: string }[] } | null
    if (res.statusCode >= 200 && res.statusCode < 300 && data && Array.isArray(data.voices) && data.voices.length) {
      ttsVoices.value = data.voices.map((m) => ({ value: m.value, label: m.label }))
      // 当前没选或选中的已不在列表里：自动选默认（来源配置），保证开箱即连得上。
      const s = currentProviderSettings()
      if (!s.voice || !data.voices.some((v) => v.value === s.voice)) {
        s.voice = data.defaultVoice || data.voices[0].value
      }
    } else {
      ttsVoices.value = []
      ttsVoiceHint.value = t('settings.voice.ttsVoiceEmpty')
    }
  } catch {
    ttsVoices.value = []
    ttsVoiceHint.value = t('settings.voice.ttsVoiceFailed')
  }
}

/** 长期记忆：从网关按本机 deviceId 拉取，可单条删除或清空。分页加载，避免记忆多时一次拉全。 */
interface MemoryItem {
  key: string
  value: string
  createdAt: number
  updatedAt: number
}
interface MemoryPage {
  items: MemoryItem[]
  total: number
  page: number
  pageSize: number
}
const MEM_PAGE_SIZE = 3
const memories = ref<MemoryItem[]>([])
const memPage = ref(1)
const memTotal = ref(0)
const memLoading = ref(false)
const memHint = ref('')

function memoriesBaseUrl(): string {
  return `${resolveGatewayHttpBase()}/api/admin/memories?deviceId=${encodeURIComponent(getDeviceId())}`
}

function getMemoriesPageUrl(): string {
  const kw = memQuery.value.trim()
  return `${memoriesBaseUrl()}&page=${memPage.value}&pageSize=${MEM_PAGE_SIZE}${kw ? `&q=${encodeURIComponent(kw)}` : ''}`
}

/** 总页数（向上取整）；当前页 / 上一页 / 下一页可用性。 */
const memTotalPages = computed(() => Math.max(1, Math.ceil(memTotal.value / MEM_PAGE_SIZE)))
const memHasPrev = computed(() => memPage.value > 1)
const memHasNext = computed(() => memPage.value < memTotalPages.value)
/** 长期记忆默认折叠，记忆多时不占首屏空间；点标题展开。 */
const memCollapsed = ref(true)
function toggleMemories(): void {
  memCollapsed.value = !memCollapsed.value
}
/** 语音设置默认折叠，展开后再编辑 ASR/LLM/TTS。 */
const voiceCollapsed = ref(true)
function toggleVoice(): void {
  voiceCollapsed.value = !voiceCollapsed.value
}
/** 播放设置默认折叠，展开后选择播放源。 */
const playbackCollapsed = ref(true)
function togglePlayback(): void {
  playbackCollapsed.value = !playbackCollapsed.value
}
/** 关键词检索：对 key / value 模糊匹配，网关 q 参数下发。 */
const memQuery = ref('')

/** 记忆更新时间（秒级时间戳）格式化展示：YYYY-MM-DD。 */
function formatMemoryTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function loadMemories(): Promise<void> {
  if (memLoading.value) return
  memLoading.value = true
  memHint.value = ''
  try {
    const res = await secureRequest({ url: getMemoriesPageUrl(), method: 'GET' })
    const body = res.data as MemoryPage | null
    if (res.statusCode >= 200 && res.statusCode < 300 && body && Array.isArray(body.items)) {
      memories.value = body.items as MemoryItem[]
      memTotal.value = typeof body.total === 'number' ? body.total : memories.value.length
      // 删条目后当前页可能越界（如删掉末页唯一一条），回退到最后一页重新拉取。
      if (memories.value.length === 0 && memPage.value > 1 && memTotal.value > 0) {
        memPage.value = memTotalPages.value
        void loadMemories()
      }
    } else {
      memHint.value = t('settings.memory.loadFailed')
    }
  } catch {
    memHint.value = t('settings.memory.loadFailed')
  } finally {
    memLoading.value = false
  }
}

/** 跳到第 p 页（按总页数夹紧），重新拉取该页（替换式分页，非追加）。 */
function gotoMemPage(p: number): void {
  const target = Math.min(Math.max(1, p), memTotalPages.value)
  if (target === memPage.value) return
  memPage.value = target
  void loadMemories()
}

function prevMemPage(): void {
  gotoMemPage(memPage.value - 1)
}

function nextMemPage(): void {
  gotoMemPage(memPage.value + 1)
}

function searchMemories(): void {
  // 检索时自动展开，并从第 1 页重新拉取（q 已拼进 getMemoriesPageUrl）。
  memCollapsed.value = false
  memPage.value = 1
  void loadMemories()
}

async function deleteMemory(item: MemoryItem): Promise<void> {
  try {
    const res = await secureRequest({
      url: `${memoriesBaseUrl()}&key=${encodeURIComponent(item.key)}`,
      method: 'DELETE',
    })
    if (res.statusCode >= 200 && res.statusCode < 300) {
      memHint.value = t('settings.memory.deleted')
      // 重新按当前页拉取，保持分页计数一致（总数由服务端返回）。
      void loadMemories()
    }
  } catch {
    memHint.value = t('settings.memory.loadFailed')
  }
}

async function clearMemories(): Promise<void> {
  try {
    const res = await secureRequest({ url: memoriesBaseUrl(), method: 'DELETE' })
    if (res.statusCode >= 200 && res.statusCode < 300) {
      memories.value = []
      memTotal.value = 0
      memPage.value = 1
      memHint.value = t('settings.memory.cleared')
    }
  } catch {
    memHint.value = t('settings.memory.loadFailed')
  }
}

function syncNavTitle(): void {
  // 导航栏标题随当前语言本地化（pages.json 里的静态标题无法 i18n，这里动态覆盖）。
  uni.setNavigationBarTitle({ title: t('app.settings') })
}

onMounted(() => {
  syncNavTitle()
  void loadMemories()
  void loadLlmModels()
  void loadTtsVoices()
})

// 语言切换时：导航栏标题与（服务端本地化的）音色标签都要跟着变。
watch(
  () => appConfig.language,
  () => {
    syncNavTitle()
    void loadTtsVoices()
  },
)
</script>

<template>
  <view class="page">
    <!-- 语言（排第一位，跟随全局；唤醒/ASR/TTS 默认语言都继承它） -->
    <view class="group">
      <SelectRow
        :title="t('settings.language.title')"
        :hint="t('settings.language.hint')"
        :options="LANGUAGE_OPTIONS"
        :model-value="appConfig.language"
        @update:model-value="(v: string) => (appConfig.language = v)"
      />
    </view>

    <!-- 时区（语言下方） -->
    <view class="group">
      <SelectRow
        :title="t('settings.timezone.title')"
        :hint="t('settings.timezone.hint')"
        :options="timezoneOptions"
        :model-value="appConfig.timezone"
        @update:model-value="(v: string) => (appConfig.timezone = v)"
      />
    </view>

    <!-- 语音服务（ASR / LLM / TTS 共用一份配置），默认折叠 -->
    <view class="group">
      <view class="group-head">
        <view class="group-title-row" @tap="toggleVoice">
          <text class="group-chevron">{{ voiceCollapsed ? '▸' : '▾' }}</text>
          <text class="group-title">{{ t('settings.voice.title') }}</text>
        </view>
      </view>
      <template v-if="!voiceCollapsed">
      <text class="row-label">{{ t('settings.voice.provider') }}</text>
      <view class="providers">
        <view
          class="provider"
          :class="{ active: appConfig.voice.provider === 'builtin' }"
          @tap="onSelectProvider('builtin')"
        >
          <view class="radio"><view v-if="appConfig.voice.provider === 'builtin'" class="radio-dot" /></view>
          <text class="provider-name">{{ t('settings.voice.builtin') }}</text>
        </view>
        <view
          class="provider"
          :class="{ active: appConfig.voice.provider === 'dashscope' }"
          @tap="onSelectProvider('dashscope')"
        >
          <view class="radio"><view v-if="appConfig.voice.provider === 'dashscope'" class="radio-dot" /></view>
          <text class="provider-name">{{ t('settings.voice.dashscope') }}</text>
        </view>
      </view>

      <!-- 内置：地址与密钥都可改，默认指向本机本地 AI 服务（9529） -->
      <view v-if="appConfig.voice.provider === 'builtin'" class="row column">
        <text class="row-label">{{ t('settings.voice.url') }}</text>
        <input
          class="input"
          v-model="appConfig.voice.builtin.url"
          placeholder="http://127.0.0.1:9529"
        />
        <text class="hint">{{ t('settings.voice.urlBuiltinHint') }}</text>
        <text class="row-label">{{ t('settings.voice.apiKey') }}</text>
        <input
          class="input"
          :password="true"
          v-model="appConfig.voice.builtin.apiKey"
          :placeholder="t('settings.voice.apiKeyHint')"
        />
        <text class="row-label">{{ t('settings.voice.llmModel') }}</text>
        <SelectRow
          :title="t('settings.voice.llmModel')"
          :hint="t('settings.voice.llmModelHint')"
          :options="llmModels"
          :model-value="appConfig.voice.builtin.model ?? ''"
          :disabled="llmModels.length === 0"
          :searchable="llmModels.length > 0"
          @update:model-value="(v: string) => (appConfig.voice.builtin.model = v)"
        />
        <text v-if="llmModelHint" class="hint" @tap="loadLlmModels">{{ llmModelHint }}</text>
        <text class="row-label">{{ t('settings.voice.ttsVoice') }}</text>
        <SelectRow
          :title="t('settings.voice.ttsVoice')"
          :hint="t('settings.voice.ttsVoiceHint')"
          :options="ttsVoices"
          :model-value="appConfig.voice.builtin.voice ?? ''"
          :disabled="ttsVoices.length === 0"
          :searchable="ttsVoices.length > 0"
          @update:model-value="(v: string) => (appConfig.voice.builtin.voice = v)"
        />
        <text v-if="ttsVoiceHint" class="hint" @tap="loadTtsVoices">{{ ttsVoiceHint }}</text>
      </view>

      <!-- 百炼：地址与密钥都可改；默认指向云端，也可填业务空间专属域名 -->
      <template v-else>
        <view class="row column">
          <text class="row-label">{{ t('settings.voice.url') }}</text>
          <input
            class="input"
            v-model="appConfig.voice.dashscope.url"
            :placeholder="DEFAULT_DASHSCOPE_URL"
          />
          <text class="hint">{{ t('settings.voice.urlDashscopeHint') }}</text>
        </view>
        <view class="row column">
          <text class="row-label">{{ t('settings.voice.apiKey') }}</text>
          <input
            class="input"
            :password="true"
            v-model="appConfig.voice.dashscope.apiKey"
            :placeholder="t('settings.voice.apiKeyHint')"
          />
        </view>
        <text class="row-label">{{ t('settings.voice.llmModel') }}</text>
        <SelectRow
          :title="t('settings.voice.llmModel')"
          :hint="t('settings.voice.llmModelHint')"
          :options="llmModels"
          :model-value="appConfig.voice.dashscope.model ?? ''"
          :disabled="llmModels.length === 0"
          :searchable="llmModels.length > 0"
          @update:model-value="(v: string) => (appConfig.voice.dashscope.model = v)"
        />
        <text v-if="llmModelHint" class="hint" @tap="loadLlmModels">{{ llmModelHint }}</text>
        <text class="row-label">{{ t('settings.voice.ttsVoice') }}</text>
        <SelectRow
          :title="t('settings.voice.ttsVoice')"
          :hint="t('settings.voice.ttsVoiceHint')"
          :options="ttsVoices"
          :model-value="appConfig.voice.dashscope.voice ?? ''"
          :disabled="ttsVoices.length === 0"
          :searchable="ttsVoices.length > 0"
          @update:model-value="(v: string) => (appConfig.voice.dashscope.voice = v)"
        />
        <text v-if="ttsVoiceHint" class="hint" @tap="loadTtsVoices">{{ ttsVoiceHint }}</text>
      </template>

      <button class="reset" @tap="onResetVoice">{{ t('settings.reset') }}</button>
      </template>
    </view>

    <!-- 播放设置（音乐播放源等），默认折叠 -->
    <view class="group">
      <view class="group-head">
        <view class="group-title-row" @tap="togglePlayback">
          <text class="group-chevron">{{ playbackCollapsed ? '▸' : '▾' }}</text>
          <text class="group-title">{{ t('settings.playback.title') }}</text>
        </view>
      </view>
      <template v-if="!playbackCollapsed">
        <text class="row-label">{{ t('settings.playback.source') }}</text>
        <view class="providers">
          <view
            v-for="opt in playbackSources"
            :key="opt.value"
            class="provider"
            :class="{ active: appConfig.playback.source === opt.value }"
            @tap="appConfig.playback.source = opt.value as PlaybackSource"
          >
            <view class="radio"><view v-if="appConfig.playback.source === opt.value" class="radio-dot" /></view>
            <text class="provider-name">{{ opt.label }}</text>
          </view>
        </view>
        <text class="hint">{{ t('settings.playback.sourceHint') }}</text>
      </template>
    </view>

    <!-- 长期记忆 -->
    <view class="group">
      <view class="group-head">
        <view class="group-title-row" @tap="toggleMemories">
          <text class="group-chevron">{{ memCollapsed ? '▸' : '▾' }}</text>
          <text class="group-title">{{ t('settings.memory.title') }}</text>
          <text v-if="memTotal" class="group-count">{{ t('settings.memory.total', { n: memTotal }) }}</text>
        </view>
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
      <input
        class="mem-search"
        type="text"
        :value="memQuery"
        :placeholder="t('settings.memory.search')"
        @input="(e: any) => { memQuery = e.detail.value ?? e.target.value ?? ''; searchMemories() }"
      />
      <template v-if="!memCollapsed">
        <text v-if="memHint" class="hint">{{ memHint }}</text>
        <text v-if="!memories.length && !memHint" class="hint">
          {{ t('settings.memory.empty') }}
        </text>
        <view v-for="item in memories" :key="item.key" class="memory-row">
          <view class="memory-text">
            <text class="memory-key">{{ item.key }}</text>
            <text class="memory-value">{{ item.value }}</text>
          </view>
          <view class="memory-meta">
            <text class="memory-time">{{ t('settings.memory.created') }} {{ formatMemoryTime(item.createdAt) }}</text>
            <text class="memory-time">{{ t('settings.memory.updated') }} {{ formatMemoryTime(item.updatedAt) }}</text>
            <text class="link" @tap="deleteMemory(item)">{{ t('settings.memory.delete') }}</text>
          </view>
        </view>
        <view v-if="memTotalPages > 1" class="mem-pager">
          <text class="link" :class="{ disabled: !memHasPrev || memLoading }" @tap="prevMemPage">
            {{ memLoading ? '…' : t('settings.memory.prev') }}
          </text>
          <text class="mem-page-ind">{{ t('settings.memory.page', { cur: memPage, total: memTotalPages }) }}</text>
          <text class="link" :class="{ disabled: !memHasNext || memLoading }" @tap="nextMemPage">
            {{ memLoading ? '…' : t('settings.memory.next') }}
          </text>
        </view>
      </template>
    </view>

    <button class="save" :disabled="saving" @tap="onSave">{{ t('settings.save') }}</button>
    <text class="foot">{{ t('settings.foot') }}</text>

    <!-- 保存中的加载遮罩 -->
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

.group-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.group-chevron {
  font-size: 12px;
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

/* picker 作为整行触发的容器，撑满宽度，避免下拉/取值错位 */
picker {
  display: block;
  width: 100%;
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
  min-width: 0;
  flex: 1;
}

.row-label {
  font-size: 13px;
  color: #e8eaf6;
}

.row-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.row-value {
  font-size: 14px;
  color: #e8eaf6;
  text-align: right;
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

.mem-search {
  width: 100%;
  height: 34px;
  line-height: 34px;
  padding: 0 12px;
  margin: 8px 0 2px;
  border-radius: 10px;
  font-size: 13px;
  color: #e8eaf6;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-sizing: border-box;
}

.mem-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 10px 0 2px;
}

.mem-page-ind {
  font-size: 12px;
  color: #b8bdd4;
}

.memory-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.memory-text {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.memory-key {
  font-size: 12px;
  font-weight: 600;
  color: #cfd8ff;
  flex-shrink: 0;
}

.memory-value {
  font-size: 13px;
  color: #e8eaf6;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.memory-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  flex-shrink: 0;
}

.memory-time {
  font-size: 10px;
  color: rgba(232, 234, 246, 0.5);
  line-height: 1.4;
}

.save {
  align-self: stretch;
  width: 100%;
  margin-top: 4px;
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

.foot {
  font-size: 11px;
  line-height: 1.6;
  color: #6f7691;
  text-align: center;
}
</style>
