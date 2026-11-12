<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { FloatPositionKey } from '@/core/adaptation/floatLayer'
import { SUBTITLE_FONT_SIZE_OPTIONS, SUBTITLE_COLOR_OPTIONS } from '@/core/config/constants'
import {
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  appConfig,
  persistConfig,
  resetPlayback,
  resetVoice,
  setVoiceProvider,
} from '@/core/config'
import { DEFAULT_DASHSCOPE_URL } from '@/core/config/constants'
import { t } from '@/core/i18n'
import { secureRequest } from '@/core/transport/secureRequest'
import { resolveGatewayHttpBase } from '@/core/transport/webSocketTransport'
import { getActiveTransport } from '@/core/transport'
import { getDeviceId } from '@/core/config/deviceId'
import { activeVoiceConfig } from '@/core/config'
import { fetchHealthReport, toHealthItems, type HealthItem } from '@/features/assistant/useHealth'
import SelectRow from '@/components/SelectRow.vue'
import { useSubPageBack } from '@/core/composables/useSubPageBack'
import SubPageNav from '@/components/SubPageNav.vue'
import { THEME_IDS, THEME_VARS, applyTheme } from '@/core/theme'

/** 时区下拉选项：值用 IANA 名，展示文案按当前语言本地化。 */
const timezoneOptions = computed(() =>
  TIMEZONE_OPTIONS.map((o) => ({ value: o.value, label: t(o.i18nKey) })),
)

/** 悬浮位置选项：key 来自通用悬浮层预设，展示文案按语言本地化 */
const FLOAT_POSITION_KEYS: FloatPositionKey[] = [
  'top-center', 'top-left', 'top-right', 'bottom-center', 'bottom-left', 'bottom-right',
]
const floatPositionOptions = computed(() =>
  FLOAT_POSITION_KEYS.map((k) => ({ value: k, label: t(`settings.playback.floatPosition.${k}`) })),
)
function setFloatPosition(value: string): void {
  appConfig.playback.floatPosition = value as FloatPositionKey
}

/** 当前字幕字号/颜色：选项来自 config/constants 的预设，值与配置同域 */
const subtitleFontSizeOptions = computed(() =>
  SUBTITLE_FONT_SIZE_OPTIONS.map((px) => ({
    value: String(px),
    label: t(`settings.playback.subtitleFontSize.${px}`),
  })),
)
const subtitleColorOptions = computed(() =>
  SUBTITLE_COLOR_OPTIONS.map((hex) => ({
    value: hex,
    label: t(`settings.playback.subtitleColor.${hex.slice(1)}`),
  })),
)
function setSubtitleFontSize(value: string): void {
  appConfig.playback.subtitleFontSize = Number(value)
}
function setSubtitleColor(value: string): void {
  appConfig.playback.subtitleColor = value
}

/** 主题色板：选项来自 core/theme 的 THEME_IDS/THEME_VARS（颜色单一来源），标签按语言本地化。
 *  auto 用「蓝/深色各半」表达「跟随系统」；其余用各自 bgBase 打底、accent 作圆点。 */
const themeOptions = computed(() =>
  THEME_IDS.map((id) => {
    const v = THEME_VARS[id === 'auto' ? 'default' : id]
    return {
      value: id,
      label: t(`settings.theme.${id}`),
      bg: id === 'auto' ? 'linear-gradient(135deg, #6c8cff 50%, #0f1220 50%)' : v.bgBase,
      dot: v.accent,
    }
  }),
)
/** 选中主题：先实时预览（立即改写 :root 变量），保存时再随 appConfig 落盘。 */
function setTheme(value: string): void {
  appConfig.general.theme = value as typeof appConfig.general.theme
  applyTheme(appConfig.general.theme)
}

const saving = ref(false)

async function onSave(): Promise<void> {
  saving.value = true
  try {
    persistConfig()
    // 设置页改了播放源：若语音会话仍连着，立即推给网关重建音乐源，无需重连/重唤醒即可生效；
    // 未连接时退化为「下一次唤醒随 session.start 生效」，不强行发（发了也没人收）。
    const transport = getActiveTransport()
    if (transport?.isConnected()) {
      transport.notifyPlaybackSource(
        appConfig.playback.source,
        appConfig.playback.autoSubtitle ?? true,
        appConfig.playback.defaultLoop,
        appConfig.playback.defaultVolume,
        appConfig.playback.autoLoop ?? false
      )
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

/** 播放设置恢复默认：清空为百度源、关闭自动收藏、开启自动字幕、关闭自动循环、默认循环 3 次、默认音量 50%。 */
function onResetPlayback(): void {
  resetPlayback()
}

/** 进入「我的收藏」页：查看/播放/移除已收藏的歌。 */
function openFavorites(): void {
  uni.navigateTo({ url: '/pages/favorites/favorites' })
}

/** 合并（摘要）阈值：收敛到非负整数（0 表示每轮都合并），非法回退 30。 */
function setConsolidateThreshold(e: any): void {
  const n = Math.floor(Number(e.detail.value))
  appConfig.memory.consolidateThreshold = Number.isFinite(n) && n >= 0 ? n : 30
}

/** 合并（摘要）频率：收敛到非负整数，非法回退 5。 */
function setConsolidateEvery(e: any): void {
  const n = Math.floor(Number(e.detail.value))
  appConfig.memory.consolidateEvery = Number.isFinite(n) && n >= 0 ? n : 5
}

/** 设置分组手风琴：同时只展开一个，打开一个时其它自动缩回，再点已展开的则收起。
 * MCP 设置默认展开，让「打开设置即可见、可添加」；样式与其余分区一致（标题右侧带收起/展开箭头）。 */
type SettingsGroup = 'general' | 'memory' | 'voice' | 'playback' | 'recommend' | 'mcp'
const expanded = ref<SettingsGroup | null>('mcp')
function isOpen(key: SettingsGroup): boolean {
  return expanded.value === key
}
function toggleGroup(key: SettingsGroup): void {
  expanded.value = expanded.value === key ? null : key
}

/** 推荐条数夹紧到 1–10 整数，非法/越界回退 3；与网关工具上限一致。 */
function clampCount(v: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n)) return 3
  return Math.min(10, Math.max(1, n))
}
function setDealsCount(e: any): void {
  appConfig.recommend.dealsCount = clampCount(e.detail.value)
}
function setOpensourceCount(e: any): void {
  appConfig.recommend.opensourceCount = clampCount(e.detail.value)
}

/** 进入好价商品列表页：查看助手推荐过的商品。 */
function openDeals(): void {
  uni.navigateTo({ url: '/pages/deals/deals' })
}

/** 进入开源工具列表页：查看助手推荐过的开源工具/软件。 */
function openOpenSource(): void {
  uni.navigateTo({ url: '/pages/opensource/opensource' })
}

/** 进入 MCP 服务器配置页：增删一组 MCP 服务器（stdio / sse / http）。 */
function openMcpServers(): void {
  uni.navigateTo({ url: '/pages/mcpservers/mcpservers' })
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
  // api-key 只落本机，必须由前端带来；内置非必填（可空），百炼必带。地址默认由网关持有中转，
  // 但当前选中的来源地址（voice.url，如自建 MAAS 实例）也要带上：让网关从「真实在用的地址」
  // 拉模型目录，而不是默认云端地址——否则列表里的模型名和真实推理地址对不上，会「模型异常」。
  // 不传 url 时网关回退自身默认地址，旧行为不变。
  if (settings.url) qs.set('url', settings.url)
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

/** 一键检测：按当前选中的来源（内置 / DashScope）探测 LLM / ASR / TTS / 外网是否正常。
 *  结果反映未保存的编辑（url / apiKey 直接读 appConfig），可先测后存。 */
const detecting = ref(false)
const detectItems = ref<HealthItem[] | null>(null)
const detectError = ref(false)
const detectProviderName = computed(() =>
  appConfig.voice.provider === 'dashscope'
    ? t('settings.voice.dashscope')
    : t('settings.voice.builtin'),
)

async function runDetection(): Promise<void> {
  if (detecting.value) return
  detecting.value = true
  detectError.value = false
  try {
    const report = await fetchHealthReport(activeVoiceConfig(), true)
    if (!report) {
      detectError.value = true
      detectItems.value = null
      return
    }
    detectItems.value = toHealthItems(report)
  } finally {
    detecting.value = false
  }
}

/** 音色下拉：选项来自网关的固定精选目录（内置=Edge-TTS 常用；百炼=官方 CosyVoice 标准），不实时拉取以便国际化。
 *  每条带 model（所属模型），渲染成下拉里的次要列，并随选择下发网关决定真正请求的 TTS 模型。 */
const ttsVoices = ref<{ value: string; label: string; subtitle?: string }[]>([])
/** value -> 所属模型 的映射，选中时把对应模型写进配置，随 params.model 下发。 */
const voiceModelMap = new Map<string, string>()
const ttsVoiceHint = ref('')

async function loadTtsVoices(): Promise<void> {
  ttsVoiceHint.value = ''
  voiceModelMap.clear()
  const provider = appConfig.voice.provider
  // 前端只与网关通信：把 provider 与当前语言带给网关，由网关按 lang 拼出本地化标签。
  const qs = new URLSearchParams({ provider, lang: appConfig.language })
  try {
    const res = await secureRequest({
      url: `${resolveGatewayHttpBase()}/api/admin/tts-voices?${qs.toString()}`,
      method: 'GET',
    })
    const data = res.data as {
      defaultVoice?: string
      defaultModel?: string
      voices?: { value: string; label: string; model?: string }[]
    } | null
    if (res.statusCode >= 200 && res.statusCode < 300 && data && Array.isArray(data.voices) && data.voices.length) {
      ttsVoices.value = data.voices.map((m) => {
        voiceModelMap.set(m.value, m.model ?? '')
        return { value: m.value, label: m.label, subtitle: m.model || undefined }
      })
      // 当前没选或选中的已不在列表里：自动选默认（来源配置），保证开箱即连得上。
      const s = currentProviderSettings()
      if (!s.voice || !data.voices.some((v) => v.value === s.voice)) {
        const dv = data.defaultVoice || data.voices[0].value
        s.voice = dv
        s.voiceModel = voiceModelMap.get(dv) || data.defaultModel || ''
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

/** 选中某个音色：同步写 voice 与它的所属模型（voiceModel），随 params 下发网关。 */
function onSelectVoice(value: string): void {
  const s = currentProviderSettings()
  s.voice = value
  s.voiceModel = voiceModelMap.get(value) || ''
}

/** 跳转到独立的「长期记忆」分页列表页。 */
function openLongMemory(): void {
  uni.navigateTo({ url: '/pages/longmemory/longmemory' })
}

// 返回：有上一级（如从首页进入）走 navigateBack；直链/刷新进入（无上一级）兜底回首页。
const { goBack } = useSubPageBack({ fallbackUrl: '/pages/index/index' })

onMounted(() => {
  void loadLlmModels()
  void loadTtsVoices()
  // 播放源目前仅百度一种（隐藏选择器），旧配置若存过其它源（netease/tencent/kugou）静默回退到百度。
  if (appConfig.playback.source !== 'baidu') {
    appConfig.playback.source = 'baidu'
  }
})

// 语言切换时：（服务端本地化的）音色标签要跟着变；导航栏标题走模板 t()，自动响应式更新。
watch(
  () => appConfig.language,
  () => {
    void loadTtsVoices()
  },
)
</script>

<template>
  <view class="page">
    <SubPageNav :title="t('app.settings')" @back="goBack" />
    <!-- 通用设置（语言 / 时区） -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('general')">
        <text class="group-title">{{ t('settings.general.title') }}</text>
        <text class="group-chevron">{{ isOpen('general') ? '▾' : '▸' }}</text>
      </view>
      <template v-if="isOpen('general')">
        <!-- 语言（跟随全局；唤醒/ASR/TTS 默认语言都继承它） -->
        <view class="sub">
          <SelectRow
            :title="t('settings.language.title')"
            :hint="t('settings.language.hint')"
            :options="LANGUAGE_OPTIONS"
            :model-value="appConfig.language"
            @update:model-value="(v: string) => (appConfig.language = v)"
          />
        </view>

        <!-- 时区（语言下方） -->
        <view class="sub">
          <SelectRow
            :title="t('settings.timezone.title')"
            :hint="t('settings.timezone.hint')"
            :options="timezoneOptions"
            :model-value="appConfig.timezone"
            @update:model-value="(v: string) => (appConfig.timezone = v)"
          />
        </view>

        <!-- 自动开启语音助手：开屏即连接网关进入待唤醒，免去手动点开关 -->
        <view class="setting-row">
          <view class="setting-text">
            <text class="row-label">{{ t('settings.general.autoConnect') }}</text>
            <text class="hint">{{ t('settings.general.autoConnectHint') }}</text>
          </view>
          <switch
            :checked="appConfig.general.autoConnect"
            color="#6c8cff"
            @change="(e: any) => (appConfig.general.autoConnect = e.detail.value)"
          />
        </view>

        <!-- 主题：选中即实时预览，保存时随 appConfig 落盘 -->
        <view class="setting-row column theme-row">
          <text class="row-label">{{ t('settings.theme.title') }}</text>
          <text class="hint">{{ t('settings.theme.hint') }}</text>
          <view class="theme-swatches">
            <view
              v-for="opt in themeOptions"
              :key="opt.value"
              class="theme-swatch"
              :class="{ active: appConfig.general.theme === opt.value }"
              :style="{ background: opt.bg }"
              :aria-label="opt.label"
              @tap="setTheme(opt.value)"
            >
              <view class="swatch-dot" :style="{ background: opt.dot }" />
              <text class="swatch-label">{{ opt.label }}</text>
            </view>
          </view>
        </view>
      </template>
    </view>

    <!-- MCP 服务器：用户自行填写，网关据此连上并把其工具注册进助手工具箱。
         与其它分区一样走折叠逻辑（标题右侧带收起/展开箭头），默认展开，打开设置即可见、一点直达配置页。 -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('mcp')">
        <text class="group-title">{{ t('settings.mcp.title') }}</text>
        <text class="group-chevron">{{ isOpen('mcp') ? '▾' : '▸' }}</text>
      </view>
      <template v-if="isOpen('mcp')">
        <!-- 总开关：关闭则整体停用 MCP，不向网关下发任何服务器 -->
        <view class="setting-row">
          <view class="setting-text">
            <text class="row-label">{{ t('settings.mcp.enabled') }}</text>
            <text class="hint">{{ t('settings.mcp.enabledHint') }}</text>
          </view>
          <switch
            :checked="appConfig.mcp.enabled"
            color="#6c8cff"
            @change="(e: any) => (appConfig.mcp.enabled = e.detail.value)"
          />
        </view>
        <view class="entry" @tap="openMcpServers">
          <view class="row-text">
            <text class="row-label">{{ t('settings.mcp.open') }}</text>
            <text class="hint">{{ t('settings.mcp.openHint') }}</text>
          </view>
          <text class="entry-arrow">›</text>
        </view>
      </template>
    </view>

    <!-- 记忆设置：自动记忆开关 + 长期记忆入口（独立分页列表页），置于通用设置之后、便于找到 -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('memory')">
        <text class="group-title">{{ t('settings.memory.title') }}</text>
        <text class="group-chevron">{{ isOpen('memory') ? '▾' : '▸' }}</text>
      </view>
      <template v-if="isOpen('memory')">
      <text class="hint">{{ t('settings.memory.sub') }}</text>

      <!-- 自动记忆开关：开启后对话里自动抽取并沉淀长期记忆；手动指令始终生效。 -->
      <view class="setting-row">
        <view class="row-text">
          <text class="row-label">{{ t('settings.memory.autoMemory') }}</text>
          <text class="hint">{{ t('settings.memory.autoMemoryHint') }}</text>
        </view>
        <switch
          class="setting-switch"
          :checked="appConfig.memory.autoMemory"
          color="#6c8cff"
          @change="(e: any) => (appConfig.memory.autoMemory = e.detail.value)"
        />
      </view>

      <!-- 合并（摘要）阈值：记忆条数达到此值才周期性合并去重；0 表示每轮都合并 -->
      <view class="setting-row column">
        <text class="row-label">{{ t('settings.memory.consolidateThreshold') }}</text>
        <input
          class="input"
          type="number"
          :value="appConfig.memory.consolidateThreshold"
          @change="setConsolidateThreshold"
        />
        <text class="hint">{{ t('settings.memory.consolidateThresholdHint') }}</text>
      </view>

      <!-- 合并（摘要）频率：每这么多次抽取触发一次合并 -->
      <view class="setting-row column">
        <text class="row-label">{{ t('settings.memory.consolidateEvery') }}</text>
        <input
          class="input"
          type="number"
          :value="appConfig.memory.consolidateEvery"
          @change="setConsolidateEvery"
        />
        <text class="hint">{{ t('settings.memory.consolidateEveryHint') }}</text>
      </view>

      <!-- 长期记忆入口：跳转到分页列表页，可检索 / 单条删除 / 清空。 -->
      <view class="entry" @tap="openLongMemory">
        <view class="row-text">
          <text class="row-label">{{ t('settings.memory.openLong') }}</text>
          <text class="hint">{{ t('settings.memory.openLongHint') }}</text>
        </view>
        <text class="entry-arrow">›</text>
      </view>
      </template>
    </view>

    <!-- 语音服务（ASR / LLM / TTS 共用一份配置） -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('voice')">
        <text class="group-title">{{ t('settings.voice.title') }}</text>
        <text class="group-chevron">{{ isOpen('voice') ? '▾' : '▸' }}</text>
      </view>
      <template v-if="isOpen('voice')">
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
          @update:model-value="onSelectVoice"
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
          @update:model-value="onSelectVoice"
        />
        <text v-if="ttsVoiceHint" class="hint" @tap="loadTtsVoices">{{ ttsVoiceHint }}</text>
      </template>

      <!-- 恢复默认 + 一键检测同一行：检测按钮在最右侧 -->
      <view class="voice-actions">
        <button class="reset" @tap="onResetVoice">{{ t('settings.reset') }}</button>
        <button class="detect-btn" :disabled="detecting" @tap="runDetection">
          {{ detecting ? t('settings.voice.detecting') : t('settings.voice.detect') }}
        </button>
      </view>
      <text class="hint">{{ t('settings.voice.detectHint', { provider: detectProviderName }) }}</text>
      <text v-if="detectError" class="detect-error">{{ t('settings.voice.detectError') }}</text>
      <view v-if="detectItems" class="detect-result">
        <view v-for="item in detectItems" :key="item.key" class="detect-row">
          <view class="dot" :class="item.status" />
          <text class="detect-key">{{ t(`settings.voice.cap.${item.key}`) }}</text>
          <text class="detect-detail">{{ item.detail }}</text>
        </view>
      </view>
      </template>
    </view>

    <!-- 播放设置（音乐播放源等），默认折叠 -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('playback')">
        <text class="group-title">{{ t('settings.playback.title') }}</text>
        <text class="group-chevron">{{ isOpen('playback') ? '▾' : '▸' }}</text>
      </view>
      <template v-if="isOpen('playback')">
        <!-- 播放源目前仅百度一种，隐藏选择器，无需用户选择；其余设置与播放源无关，全局生效 -->

        <!-- 播放完自动收藏：与播放源无关，全局一个开关 -->
        <view class="setting-row">
          <view class="setting-text">
            <text class="row-label">{{ t('settings.playback.autoSave') }}</text>
            <text class="hint">{{ t('settings.playback.autoSaveHint') }}</text>
          </view>
          <switch
            :checked="appConfig.playback.autoSave"
            color="#6c8cff"
            @change="(e: any) => (appConfig.playback.autoSave = e.detail.value)"
          />
        </view>

        <!-- 自动显示字幕：与播放源无关，全局一个开关；播放音乐时同源字幕自动拉取展示 -->
        <view class="setting-row">
          <view class="setting-text">
            <text class="row-label">{{ t('settings.playback.autoSubtitle') }}</text>
            <text class="hint">{{ t('settings.playback.autoSubtitleHint') }}</text>
          </view>
          <switch
            :checked="appConfig.playback.autoSubtitle"
            color="#6c8cff"
            @change="(e: any) => (appConfig.playback.autoSubtitle = e.detail.value)"
          />
        </view>

        <!-- 悬浮小圆播放器：纯客户端 UI 开关（通用悬浮层的一个业务），不下发网关 -->
        <view class="setting-row">
          <view class="setting-text">
            <text class="row-label">{{ t('settings.playback.floatPlayer') }}</text>
            <text class="hint">{{ t('settings.playback.floatPlayerHint') }}</text>
          </view>
          <switch
            :checked="appConfig.playback.floatPlayer"
            color="#6c8cff"
            @change="(e: any) => (appConfig.playback.floatPlayer = e.detail.value)"
          />
        </view>

        <!-- 悬浮位置：通用悬浮层的位置参数，业务只传 key -->
        <SelectRow
          :title="t('settings.playback.floatPosition')"
          :hint="t('settings.playback.floatPositionHint')"
          :options="floatPositionOptions"
          :model-value="appConfig.playback.floatPosition ?? 'top-center'"
          @update:model-value="setFloatPosition"
        />

        <!-- 当前字幕样式：字号档位 + 颜色预设，应用到悬浮当前句与字幕面板高亮行 -->
        <SelectRow
          :title="t('settings.playback.subtitleFontSize')"
          :hint="t('settings.playback.subtitleFontSizeHint')"
          :options="subtitleFontSizeOptions"
          :model-value="String(appConfig.playback.subtitleFontSize ?? 18)"
          @update:model-value="setSubtitleFontSize"
        />
        <SelectRow
          :title="t('settings.playback.subtitleColor')"
          :hint="t('settings.playback.subtitleColorHint')"
          :options="subtitleColorOptions"
          :model-value="appConfig.playback.subtitleColor ?? '#ffffff'"
          @update:model-value="setSubtitleColor"
        />

        <!-- 自动循环播放：全局开关；开启后每次新播放默认按默认循环次数循环 -->
        <view class="setting-row">
          <view class="setting-text">
            <text class="row-label">{{ t('settings.playback.autoLoop') }}</text>
            <text class="hint">{{ t('settings.playback.autoLoopHint') }}</text>
          </view>
          <switch
            :checked="appConfig.playback.autoLoop"
            color="#6c8cff"
            @change="(e: any) => (appConfig.playback.autoLoop = e.detail.value)"
          />
        </view>

        <!-- 默认循环次数：非负整数，0 表示不循环 -->
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.playback.defaultLoop') }}</text>
          <input
            class="input"
            type="number"
            v-model.number="appConfig.playback.defaultLoop"
          />
          <text class="hint">{{ t('settings.playback.defaultLoopHint') }}</text>
        </view>

        <!-- 默认音量：0–100%，与播放器音量同域 -->
        <view class="setting-row column">
          <text class="row-label">
            {{ t('settings.playback.defaultVolume') }} · {{ Math.round(appConfig.playback.defaultVolume * 100) }}%
          </text>
          <slider
            :value="Math.round(appConfig.playback.defaultVolume * 100)"
            activeColor="#6c8cff"
            backgroundColor="#3a3f55"
            block-size="18"
            @change="(e: any) => (appConfig.playback.defaultVolume = e.detail.value / 100)"
            @changing="(e: any) => (appConfig.playback.defaultVolume = e.detail.value / 100)"
          />
          <text class="hint">{{ t('settings.playback.defaultVolumeHint') }}</text>
        </view>

        <!-- 我的收藏入口 -->
        <view class="entry" @tap="openFavorites">
          <text class="entry-label">{{ t('settings.playback.favorites') }}</text>
          <text class="entry-arrow">›</text>
        </view>

        <button class="reset" @tap="onResetPlayback">{{ t('settings.reset') }}</button>
      </template>
    </view>

    <!-- 推荐设置（好价商品 / 开源工具推荐条数），默认折叠，位于播放设置之后 -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('recommend')">
        <text class="group-title">{{ t('settings.recommend.title') }}</text>
        <text class="group-chevron">{{ isOpen('recommend') ? '▾' : '▸' }}</text>
      </view>
      <template v-if="isOpen('recommend')">
        <!-- 好价商品推荐条数：1–10，默认 3；经 session.start.recommend 下发网关作为工具默认条数 -->
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.recommend.dealsCount') }}</text>
          <input
            class="input"
            type="number"
            :value="appConfig.recommend.dealsCount"
            @change="setDealsCount"
          />
          <text class="hint">{{ t('settings.recommend.dealsCountHint') }}</text>
        </view>

        <!-- 开源工具推荐条数：1–10，默认 3；同上 -->
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.recommend.opensourceCount') }}</text>
          <input
            class="input"
            type="number"
            :value="appConfig.recommend.opensourceCount"
            @change="setOpensourceCount"
          />
          <text class="hint">{{ t('settings.recommend.opensourceCountHint') }}</text>
        </view>

        <!-- 好价商品列表入口：查看助手推荐过的商品（持久化，仿收藏） -->
        <view class="entry" @tap="openDeals">
          <text class="entry-label">{{ t('settings.recommend.deals') }}</text>
          <text class="entry-arrow">›</text>
        </view>

        <!-- 开源工具列表入口：查看助手推荐过的开源工具/软件 -->
        <view class="entry" @tap="openOpenSource">
          <text class="entry-label">{{ t('settings.recommend.opensource') }}</text>
          <text class="entry-arrow">›</text>
        </view>
      </template>
    </view>

    <!-- 记忆设置 -->
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
    radial-gradient(120% 50% at 50% 0%, var(--bg-glow), transparent 60%),
    var(--bg-base);
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

.group-head {
  cursor: pointer;
}

.sub {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  border-color: rgba(var(--accent-rgb), 0.6);
  background: rgba(var(--accent-rgb), 0.12);
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

/* 恢复默认在左、一键检测在右，两端对齐 */
.voice-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

/* 一键检测：按钮 + 结果卡片 */
.detect-btn {
  margin: 0;
  height: 34px;
  line-height: 34px;
  padding: 0 16px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border: none;
}

.detect-btn::after {
  border: none;
}

.detect-btn[disabled] {
  opacity: 0.6;
}

.detect-error {
  font-size: 11px;
  line-height: 1.5;
  color: #ff8a8a;
}

.detect-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.detect-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot.ok {
  background: #4ec98a;
  box-shadow: 0 0 6px rgba(78, 201, 138, 0.6);
}

.dot.warn {
  background: #f5c451;
  box-shadow: 0 0 6px rgba(245, 196, 81, 0.6);
}

.dot.down {
  background: #ff6b6b;
  box-shadow: 0 0 6px rgba(255, 107, 107, 0.6);
}

.detect-key {
  font-size: 12px;
  color: #cfd8ff;
  width: 64px;
  flex-shrink: 0;
}

.detect-detail {
  font-size: 11px;
  line-height: 1.5;
  color: #9aa0bd;
  flex: 1;
  min-width: 0;
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
  color: var(--accent);
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

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.setting-row.column {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

/* 主题色板：横排若干圆角色卡，选中项加强调描边 */
.theme-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
}

.theme-swatch {
  position: relative;
  width: 92px;
  height: 56px;
  border-radius: 12px;
  border: 2px solid transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  cursor: pointer;
}

.theme-swatch.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.swatch-dot {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.4);
}

.swatch-label {
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}

.setting-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 12px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.entry-label {
  font-size: 13px;
  color: #e8eaf6;
}

.entry-arrow {
  font-size: 16px;
  color: #6f7691;
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
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
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
  border-top-color: var(--accent);
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
