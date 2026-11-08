<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  CAPABILITIES,
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  appConfig,
  getProvider,
  getProviderValues,
  languageLabel,
  persistConfig,
  providerOptions,
  resetCapability,
  setFieldValue,
  setProvider,
  type Capability,
  type ConfigValue,
  type ProviderField,
} from '@/core/config'
import { t } from '@/core/i18n'
import { fetchModelList, testConnection } from '@/core/config/tester'
import { secureRequest } from '@/core/transport/secureRequest'
import { resolveGatewayHttpBase } from '@/core/transport/webSocketTransport'
import { getDeviceId } from '@/core/config/deviceId'

const reveal = reactive<Record<string, boolean>>({})
const drafts = reactive<Record<string, string>>({})
const testing = reactive<Record<Capability, boolean>>({
  asr: false,
  llm: false,
  tts: false,
})
const results = reactive<
  Record<Capability, { ok: boolean; message: string } | null>
>({ asr: null, llm: null, tts: null })
/** 音乐为网关内置能力，无客户端配置，不在此列出 */
const testableCapabilities: Capability[] = ['asr', 'llm', 'tts']
/** 各厂商拉取到的模型列表，key = `${capability}.${providerId}`；有值时「模型」渲染成下拉 */
const modelOptions = reactive<Record<string, string[]>>({})
const fetchingModel = reactive<Record<string, boolean>>({})
/** 保存/恢复的结果用页面内文字展示，不用浮层 */
const saveHint = ref('')

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
  return `${resolveGatewayHttpBase()}/api/memories?deviceId=${encodeURIComponent(getDeviceId())}`
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

const cards = computed(() =>
  CAPABILITIES.map((item) => ({
    ...item,
    template: getProvider(item.key),
    values: getProviderValues(item.key),
  }))
)

const languageIndex = computed(() =>
  Math.max(
    0,
    LANGUAGE_OPTIONS.findIndex((item) => item.value === appConfig.language)
  )
)
const languageLabels = LANGUAGE_OPTIONS.map((item) => item.label)

const timezoneIndex = computed(() =>
  Math.max(
    0,
    TIMEZONE_OPTIONS.findIndex((item) => item.value === appConfig.timezone)
  )
)
const timezoneLabels = TIMEZONE_OPTIONS.map((item) => item.label)

function eventValue(event: Event): unknown {
  return (event as unknown as { detail?: { value?: unknown } }).detail?.value
}

function valueOf(
  capability: Capability,
  field: ProviderField
): ConfigValue | undefined {
  return getProviderValues(capability)[field.key]
}

function fieldKey(capability: Capability, field: ProviderField): string {
  return `${capability}.${field.key}`
}

function fieldOptions(field: ProviderField): Array<{
  label: string
  value: string
}> {
  return field.options ?? []
}

function fieldLabels(field: ProviderField): string[] {
  return fieldOptions(field).map((option) => option.label)
}

function fieldSelectIndex(
  capability: Capability,
  field: ProviderField
): number {
  const current = String(valueOf(capability, field) ?? '')
  const index = fieldOptions(field).findIndex(
    (option) => option.value === current
  )
  return index < 0 ? 0 : index
}

function fieldSelectLabel(
  capability: Capability,
  field: ProviderField
): string {
  const current = String(valueOf(capability, field) ?? '')
  return (
    fieldOptions(field).find((option) => option.value === current)?.label ??
    current
  )
}

/** 仅「模型」这类自由文本字段支持拉取下拉；已是静态 select 的厂商不重复处理 */
function isModelFetchable(field: ProviderField): boolean {
  return field.key === 'model' && field.type === 'text'
}

function modelKey(capability: Capability): string {
  return `${capability}.${appConfig[capability].provider}`
}

function modelList(capability: Capability): string[] {
  return modelOptions[modelKey(capability)] ?? []
}

function modelSelectIndex(capability: Capability): number {
  const list = modelList(capability)
  const current = String(getProviderValues(capability).model ?? '')
  const index = list.findIndex((item) => item === current)
  return index < 0 ? 0 : index
}

/** 从厂商接口拉取模型列表；拉到后把「模型」变成下拉，当前值不在列表则取第一项 */
async function onFetchModels(capability: Capability): Promise<void> {
  const key = modelKey(capability)
  if (fetchingModel[key]) return
  fetchingModel[key] = true
  try {
    const list = await fetchModelList(capability, getProvider(capability), {
      ...getProviderValues(capability),
    })
    if (!list.length) {
      results[capability] = {
        ok: false,
        message: '未获取到模型列表，请检查地址 / Key，或手动填写模型名',
      }
      return
    }
    modelOptions[key] = list
    const current = String(getProviderValues(capability).model ?? '')
    if (!list.includes(current)) {
      setFieldValue(capability, modelSelectField(list), list[0])
    }
    results[capability] = { ok: true, message: `已获取 ${list.length} 个模型` }
  } finally {
    fetchingModel[key] = false
  }
}

function modelSelectField(list: string[]): ProviderField {
  return {
    key: 'model',
    label: '模型',
    type: 'select',
    options: list.map((value) => ({ label: value, value })),
  }
}

function onModelSelect(capability: Capability, event: Event): void {
  const index = Number(eventValue(event))
  const list = modelList(capability)
  const value = list[index]
  if (value === undefined) return
  setFieldValue(capability, modelSelectField(list), value)
}

function inputType(field: ProviderField): string {
  if (field.type !== 'number') return 'text'
  return field.step !== undefined && field.step < 1 ? 'digit' : 'number'
}

function providerLabels(capability: Capability): string[] {
  return providerOptions(capability).map((option) => option.label)
}

function providerIndex(capability: Capability): number {
  const index = providerOptions(capability).findIndex(
    (option) => option.id === appConfig[capability].provider
  )
  return index < 0 ? 0 : index
}

function onProviderChange(capability: Capability, event: Event): void {
  const index = Number(eventValue(event))
  const option = providerOptions(capability)[index]
  if (!option) return
  setProvider(capability, option.id)
  results[capability] = null
}

function onLanguageChange(event: Event): void {
  const index = Number(eventValue(event))
  const option = LANGUAGE_OPTIONS[index]
  if (option) appConfig.language = option.value
}

function onTimezoneChange(event: Event): void {
  const index = Number(eventValue(event))
  const option = TIMEZONE_OPTIONS[index]
  if (option) appConfig.timezone = option.value
}

function onFieldInput(
  capability: Capability,
  field: ProviderField,
  event: Event
): void {
  const raw = eventValue(event)
  if (field.type === 'number') {
    drafts[fieldKey(capability, field)] = String(raw ?? '')
    return
  }
  setFieldValue(capability, field, raw)
}

function commitNumber(capability: Capability, field: ProviderField): void {
  const key = fieldKey(capability, field)
  const draft = drafts[key]
  if (draft === undefined) return
  setFieldValue(capability, field, draft)
  delete drafts[key]
}

function onFieldSelect(
  capability: Capability,
  field: ProviderField,
  event: Event
): void {
  const index = Number(eventValue(event))
  const option = fieldOptions(field)[index]
  if (option) setFieldValue(capability, field, option.value)
}

function toggleReveal(capability: Capability, field: ProviderField): void {
  const key = fieldKey(capability, field)
  reveal[key] = !reveal[key]
}

async function runTest(capability: Capability): Promise<void> {
  if (testing[capability]) return
  testing[capability] = true
  results[capability] = null
  try {
    const result = await testConnection(
      capability,
      getProvider(capability),
      { ...getProviderValues(capability) }
    )
    results[capability] = result
  } finally {
    testing[capability] = false
  }
}

function onReset(capability: Capability): void {
  resetCapability(capability)
  results[capability] = null
  persistConfig()
  saveHint.value = '已恢复默认'
}

function onSave(): void {
  persistConfig()
  saveHint.value = '已保存，重开语音助手生效'
}

onMounted(() => {
  void loadMemories()
})
</script>

<template>
  <view class="page">
    <view class="notice">
      <text class="notice-title">当前模式：自带服务（BYOK）</text>
      <text class="notice-text">
        登录与计费上线后，付费用户可切换到平台托管，无需配置下面的各项。
      </text>
    </view>

    <view class="card">
      <view class="card-head">
        <text class="card-title">语言</text>
        <text class="card-sub">唤醒、ASR、TTS 的默认语言</text>
      </view>
      <picker
        :range="languageLabels"
        :value="languageIndex"
        @change="onLanguageChange"
      >
        <view class="picker-row">
          <text class="picker-value">{{ languageLabel(appConfig.language) }}</text>
          <text class="picker-arrow">›</text>
        </view>
      </picker>
      <text class="hint">厂商里语言留空时使用这里的值；唤醒识别同样跟随。</text>
    </view>

    <view class="card">
      <view class="card-head">
        <text class="card-title">{{ t('settings.timezone.title') }}</text>
        <text class="card-sub">{{ t('settings.timezone.sub') }}</text>
      </view>
      <picker
        :range="timezoneLabels"
        :value="timezoneIndex"
        @change="onTimezoneChange"
      >
        <view class="picker-row">
          <text class="picker-value">{{ timezoneLabels[timezoneIndex] }}</text>
          <text class="picker-arrow">›</text>
        </view>
      </picker>
      <text class="hint">{{ t('settings.timezone.hint') }}</text>
    </view>

    <view v-for="card in cards" :key="card.key" class="card">
      <view class="card-head">
        <text class="card-title">{{ card.title }}</text>
        <text class="card-sub">{{ card.subtitle }}</text>
      </view>

      <picker
        :range="providerLabels(card.key)"
        :value="providerIndex(card.key)"
        @change="onProviderChange(card.key, $event)"
      >
        <view class="picker-row">
          <text class="picker-label">厂商</text>
          <view class="picker-right">
            <text class="picker-value">{{ card.template.vendor }}</text>
            <text class="picker-arrow">›</text>
          </view>
        </view>
      </picker>

      <text class="provider-name">{{ card.template.name }}</text>
      <text v-if="card.template.description" class="provider-desc">
        {{ card.template.description }}
      </text>

      <view
        v-for="field in card.template.fields"
        :key="field.key"
        class="field"
        :class="{ inline: field.type === 'switch' }"
      >
        <view class="field-head">
          <text class="field-label">{{ field.label }}</text>
          <text
            v-if="field.type === 'password'"
            class="field-toggle"
            @tap="toggleReveal(card.key, field)"
          >
            {{ reveal[fieldKey(card.key, field)] ? '隐藏' : '显示' }}
          </text>
          <text
            v-if="isModelFetchable(field)"
            class="field-toggle"
            @tap="onFetchModels(card.key)"
          >
            {{ fetchingModel[modelKey(card.key)] ? '获取中…' : '获取模型' }}
          </text>
        </view>

        <picker
          v-if="isModelFetchable(field) && modelList(card.key).length"
          :range="modelList(card.key)"
          :value="modelSelectIndex(card.key)"
          @change="onModelSelect(card.key, $event)"
        >
          <view class="picker-row compact">
            <text class="picker-value">
              {{ String(valueOf(card.key, field) ?? '') || '选择模型' }}
            </text>
            <text class="picker-arrow">›</text>
          </view>
        </picker>

        <picker
          v-else-if="field.type === 'select'"
          :range="fieldLabels(field)"
          :value="fieldSelectIndex(card.key, field)"
          @change="onFieldSelect(card.key, field, $event)"
        >
          <view class="picker-row compact">
            <text class="picker-value">
              {{ fieldSelectLabel(card.key, field) }}
            </text>
            <text class="picker-arrow">›</text>
          </view>
        </picker>

        <switch
          v-else-if="field.type === 'switch'"
          :checked="valueOf(card.key, field) === true"
          color="#6c8cff"
          @change="onFieldInput(card.key, field, $event)"
        />

        <textarea
          v-else-if="field.type === 'textarea'"
          class="input textarea"
          :value="String(valueOf(card.key, field) ?? '')"
          :placeholder="field.placeholder"
          auto-height
          @input="onFieldInput(card.key, field, $event)"
        />

        <input
          v-else
          class="input"
          :type="inputType(field)"
          :password="
            field.type === 'password' && !reveal[fieldKey(card.key, field)]
          "
          :value="
            field.type === 'number'
              ? drafts[fieldKey(card.key, field)] ??
                String(valueOf(card.key, field) ?? '')
              : String(valueOf(card.key, field) ?? '')
          "
          :placeholder="field.placeholder"
          @input="onFieldInput(card.key, field, $event)"
          @blur="commitNumber(card.key, field)"
        />

        <text v-if="field.hint" class="field-hint">{{ field.hint }}</text>
      </view>

      <view class="card-actions">
        <button
          v-if="testableCapabilities.includes(card.key)"
          class="mini-btn"
          :disabled="testing[card.key]"
          @tap="runTest(card.key)"
        >
          {{ testing[card.key] ? '测试中…' : '测试连接' }}
        </button>
        <button class="mini-btn ghost" @tap="onReset(card.key)">
          恢复默认
        </button>
      </view>

      <text
        v-if="results[card.key]"
        class="result"
        :class="{ bad: results[card.key]?.ok === false }"
      >
        {{ results[card.key]?.message }}
      </text>
    </view>

    <view class="card">
      <view class="card-head">
        <text class="card-title">{{ t('settings.memory.title') }}</text>
        <text class="card-sub">{{ t('settings.memory.sub') }}</text>
      </view>
      <view class="card-actions">
        <button class="mini-btn ghost" :disabled="memLoading" @tap="loadMemories">
          {{ memLoading ? '…' : t('settings.memory.refresh') }}
        </button>
        <button
          v-if="memories.length"
          class="mini-btn ghost"
          :disabled="memLoading"
          @tap="clearMemories"
        >
          {{ t('settings.memory.clearAll') }}
        </button>
      </view>
      <text v-if="memHint" class="result">{{ memHint }}</text>
      <text v-if="!memories.length && !memHint" class="hint">
        {{ t('settings.memory.empty') }}
      </text>
      <view v-for="item in memories" :key="item.key" class="memory-row">
        <view class="memory-text">
          <text class="memory-key">{{ item.key }}</text>
          <text class="memory-value">{{ item.value }}</text>
        </view>
        <text class="field-toggle" @tap="deleteMemory(item)">
          {{ t('settings.memory.delete') }}
        </text>
      </view>
    </view>

    <button class="save" @tap="onSave">保存配置</button>
    <text v-if="saveHint" class="save-hint">{{ saveHint }}</text>
    <text class="foot">
      配置只保存在本机。切换厂商会保留各自参数，换回来不用重填。
    </text>
  </view>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 20px 20px calc(32px + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
  gap: 16px;
  background:
    radial-gradient(120% 50% at 50% 0%, rgba(108, 140, 255, 0.18), transparent 60%),
    #0f1220;
}

.notice {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border-radius: 14px;
  background: rgba(92, 214, 178, 0.08);
  border: 1px solid rgba(92, 214, 178, 0.25);
}

.notice-title {
  font-size: 13px;
  font-weight: 600;
  color: #9be8cd;
}

.notice-text {
  font-size: 12px;
  line-height: 1.6;
  color: #8fb6ab;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.card-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: #e8eaf6;
}

.card-sub {
  font-size: 11px;
  color: #8b91ab;
}

.picker-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.picker-row.compact {
  padding: 9px 12px;
}

.picker-label {
  font-size: 13px;
  color: #9aa1bd;
}

.picker-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.picker-value {
  font-size: 14px;
  color: #e8eaf6;
}

.picker-arrow {
  font-size: 16px;
  color: #6f7691;
}

.provider-name {
  font-size: 12px;
  color: #cfd8ff;
}

.provider-desc {
  font-size: 11px;
  line-height: 1.6;
  color: #7d84a0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field.inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.field-label {
  font-size: 12px;
  color: #9aa1bd;
}

.field-toggle {
  font-size: 11px;
  color: #6c8cff;
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

.textarea {
  min-height: 72px;
  line-height: 1.6;
}

.field-hint {
  font-size: 11px;
  line-height: 1.5;
  color: #6f7691;
}

.card-actions {
  display: flex;
  gap: 10px;
  margin-top: 2px;
}

.mini-btn {
  flex: 1;
  margin: 0;
  height: 38px;
  line-height: 38px;
  border-radius: 10px;
  font-size: 13px;
  color: #e8eaf6;
  background: rgba(108, 140, 255, 0.18);
  border: 1px solid rgba(108, 140, 255, 0.35);
}

.mini-btn.ghost {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.1);
  color: #b8bdd4;
}

.mini-btn::after {
  border: none;
}

.mini-btn[disabled] {
  opacity: 0.5;
}

.result {
  font-size: 12px;
  line-height: 1.5;
  color: #9be8cd;
  word-break: break-all;
}

.result.bad {
  color: #ff9a9a;
}

.save {
  margin-top: 6px;
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
</style>
