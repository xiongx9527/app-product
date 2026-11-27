<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { FloatPositionKey } from '@/core/adaptation/floatLayer'
import { SUBTITLE_FONT_SIZE_OPTIONS, SUBTITLE_COLOR_OPTIONS, AUTO_CHECK_INTERVAL_OPTIONS, DEFAULT_DUCK_LEVEL, DUCK_LEVEL_OPTIONS, DUCK_LEVEL_PERCENT, type DuckLevel } from '@/core/config/constants'
import {
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  appConfig,
  createDefaultPlayback,
  normalizeTimeouts,
  persistConfig,
  resetPlayback,
  resetTimeouts,
  resetVoice,
} from '@/core/config'
import { t } from '@/core/i18n'
import { setDuckConfig, setAecUserEnabled } from '@/core/audio/appCapture'
import { restartGatewayViaNative, waitGatewayAlive, fetchGatewaySkills, type GatewaySkill } from '@/core/transport/gatewayControl'
import { refreshDuckVolume } from '@/core/audio/musicPlayer'
import { secureRequest } from '@/core/transport/secureRequest'
import { resolveGatewayHttpBase } from '@/core/transport/webSocketTransport'
import { getActiveTransport } from '@/core/transport'
import { getDeviceId } from '@/core/config/deviceId'
import { activeVoiceConfig } from '@/core/config'
import { fetchHealthReport, toHealthItems, type HealthItem } from '@/features/assistant/useHealth'
import SelectRow from '@/components/SelectRow.vue'
import { useSubPageBack } from '@/core/composables/useSubPageBack'
import SubPageNav from '@/components/SubPageNav.vue'
import { THEME_IDS, THEME_VARS } from '@/core/theme'
import { useThemeStyle } from '@/core/composables/useTheme'

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
 *  各主题用各自 bgBase 打底、accent 作圆点。 */
const themeOptions = computed(() =>
  THEME_IDS.map((id) => {
    const v = THEME_VARS[id]
    return {
      value: id,
      label: t(`settings.theme.${id}`),
      bg: v.bgBase,
      dot: v.accent,
    }
  }),
)
/** 选中主题：改内存配置并立即落盘。页面根元素的 :style 已响应式绑定主题变量，
 * 落盘后所有已打开页面（含本页实时预览、返回的首页）会自动同步换色，无需手动广播。 */
function setTheme(value: string): void {
  appConfig.general.theme = value as typeof appConfig.general.theme
  persistConfig()
}

// 本页根元素绑定响应式主题变量（见模板 :style）
const { themeStyle, dataTheme } = useThemeStyle()

const saving = ref(false)
/** 仅「未同步到网关」时置 true：行内红字如实报错。保存成功不显示文字（加载遮罩已足够）、不用 showToast。 */
const saveFailed = ref(false)
/** 临时诊断：保存失败的真实错误信息（App 请求层 errMsg），定位后删除 */
const saveErrDetail = ref('')

async function onSave(): Promise<void> {
  saving.value = true
  saveFailed.value = false
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
    // 保存配置必须走网关、落进网关 SQLite：POST 成功（2xx）才算保存成功。
    // 网关没启动 / 请求失败 / 非 2xx 时如实报错，不谎报「已保存」——本机那份只是离线兜底。
    // 用 JSON.parse(JSON.stringify(...)) 把 reactive 代理转成纯对象，避免序列化出意外结构。
    try {
      const res = await secureRequest({
        url: `${resolveGatewayHttpBase()}/api/admin/config?deviceId=${encodeURIComponent(getDeviceId())}`,
        method: 'POST',
        data: JSON.parse(JSON.stringify(appConfig)),
        header: { 'content-type': 'application/json' },
      })
      saveFailed.value = !(res.statusCode >= 200 && res.statusCode < 300)
    } catch (e: any) {
      saveFailed.value = true
      const msg = e?.errMsg ?? e?.message ?? (typeof e === 'string' ? e : JSON.stringify(e))
      saveErrDetail.value = ' [diag ' + String(msg).slice(0, 120) + ']'
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

/** 对话设置恢复默认：本组项（duck/插话/AEC/定稿/退下 + 已并入的超时预算）一起重置，不动播放源与音量。 */
function onResetDialog(): void {
  const playback = createDefaultPlayback()
  appConfig.general.interruptDuck = true
  appConfig.general.duckLevel = DEFAULT_DUCK_LEVEL
  appConfig.general.bargeIn = false
  appConfig.general.aecEnabled = true
  appConfig.playback.finalizeMaxChars = playback.finalizeMaxChars
  appConfig.playback.finalizeTimeoutMs = playback.finalizeTimeoutMs
  appConfig.playback.ttsConcurrency = playback.ttsConcurrency
  appConfig.playback.autoExitMs = playback.autoExitMs
  appConfig.playback.autoExitGraceMs = playback.autoExitGraceMs
  resetTimeouts() // 超时项已并入对话设置，一并恢复默认
  persistConfig()
  applyDuckConfig()
  refreshDuckVolume()
}

/** 时间项失焦即按范围夹取：填 0 或超大值只在输入框里显示，不真的下发（网关侧还有一层同范围收敛）。 */
function onTimeoutBlur(): void {
  appConfig.timeouts = normalizeTimeouts(appConfig.timeouts)
}

/** 手动重启网关：网关卡死（喊话/点球没反应）时点此恢复，复用与点球重启同一原生通道。
 *  点按钮先展开行内红色确认条（说明+确认/取消），确认才真的重启，避免误触。
 *  重启后 WS 会断、由 transport 自动重连；结果放页面固定区行内文字，不用 toast 浮层。 */
const gatewayRestartMsg = ref('')
const gatewayRestarting = ref(false)
const gatewayRestartConfirm = ref(false)
function askRestartGateway(): void {
  gatewayRestartConfirm.value = !gatewayRestartConfirm.value
  gatewayRestartMsg.value = ''
}
function cancelRestartGateway(): void {
  gatewayRestartConfirm.value = false
}
async function onRestartGateway(): Promise<void> {
  if (gatewayRestarting.value) return
  gatewayRestartConfirm.value = false
  gatewayRestarting.value = true
  gatewayRestartMsg.value = t('settings.gateway.restarting')
  try {
    const ok = await restartGatewayViaNative()
    if (!ok) {
      gatewayRestartMsg.value = t('settings.gateway.restartUnavailable')
      return
    }
    // 重启已发起：轮询 ping 等真正恢复，别让文字永远停在"正在恢复连接…"误导用户
    gatewayRestartMsg.value = t('settings.gateway.restarted')
    const alive = await waitGatewayAlive(30000)
    gatewayRestartMsg.value = alive ? t('settings.gateway.recovered') : t('settings.gateway.recoverTimeout')
  } catch {
    gatewayRestartMsg.value = t('settings.gateway.restartUnavailable')
  } finally {
    gatewayRestarting.value = false
  }
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
 * 各分区一律默认折叠，样式一致（标题右侧带收起/展开箭头）。 */
type SettingsGroup = 'general' | 'voice' | 'dialog' | 'playback' | 'recommend' | 'memory' | 'mcp' | 'skill'
const expanded = ref<SettingsGroup | null>(null)
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

/** 进入好价商品列表页：查看助手推荐过的商品。 */
function openDeals(): void {
  uni.navigateTo({ url: '/pages/deals/deals' })
}

/** LLM 模型下拉：选项来自内置来源已配置的上游模型。 */
const llmModels = ref<{ value: string; label: string }[]>([])
const llmModelHint = ref('')

/** 当前语音服务配置（恒为内置来源）。 */
function currentProviderSettings() {
  return appConfig.voice.builtin
}

async function loadLlmModels(): Promise<void> {
  llmModelHint.value = ''
  try {
    // 用纯字符串拼接，不依赖 URLSearchParams：App 逻辑层 JS 引擎对 Web API 支持不齐，
    // 早期在 try 外抛错会让整个 load 静默失败、数组停在 [] → 下拉 forever disabled。
    const url = `${resolveGatewayHttpBase()}/api/admin/llm-models?provider=builtin`
    const res = await secureRequest({ url, method: 'GET' })
    const data = res.data as { models?: string[] } | null
    if (res.statusCode >= 200 && res.statusCode < 300 && data && Array.isArray(data.models) && data.models.length) {
      llmModels.value = [USE_SOURCE_DEFAULT.value, ...data.models.map((m) => ({ value: m, label: m }))]
    } else {
      llmModels.value = [USE_SOURCE_DEFAULT.value]
      llmModelHint.value = t('settings.voice.llmModelEmpty')
    }
  } catch (e) {
    llmModels.value = [USE_SOURCE_DEFAULT.value]
    llmModelHint.value = t('settings.voice.llmModelFailed')
  }
}

/** ASR / TTS 模型下拉：「沿用来源默认」空选项 —— 空串表示跟随来源默认模型（推荐）。 */
const USE_SOURCE_DEFAULT = computed(() => ({ value: '', label: t('settings.voice.useSourceDefault') }))

/** ASR 模型下拉：选项来自网关的实时目录 + 官方清单兜底（保证两个来源永远有得选）。 */
const asrModels = ref<{ value: string; label: string }[]>([])
const asrModelHint = ref('')

async function loadAsrModels(): Promise<void> {
  asrModelHint.value = ''
  try {
    // 前端只与网关通信：模型目录由网关持有来源地址并中转，前端只传 provider + capability。
    // 纯字符串拼接，不依赖 URLSearchParams（App 逻辑层 Web API 支持不齐）。
    const parts = ['provider=builtin', 'capability=asr']
    const res = await secureRequest({
      url: `${resolveGatewayHttpBase()}/api/admin/voice-models?${parts.join('&')}`,
      method: 'GET',
    })
    const data = res.data as { models?: string[] } | null
    if (res.statusCode >= 200 && res.statusCode < 300 && data && Array.isArray(data.models)) {
      asrModels.value = [USE_SOURCE_DEFAULT.value, ...data.models.map((m) => ({ value: m, label: m }))]
      // 当前没选或选中的已不在列表里：回退「沿用来源默认」，保证选值始终有效。
      const s = currentProviderSettings()
      if (s.asrModel && !data.models.includes(s.asrModel)) s.asrModel = ''
    } else {
      asrModels.value = [USE_SOURCE_DEFAULT.value]
      asrModelHint.value = t('settings.voice.asrModelEmpty')
    }
  } catch (e) {
    asrModels.value = [USE_SOURCE_DEFAULT.value]
    asrModelHint.value = t('settings.voice.asrModelFailed')
  }
}

/** TTS 模型下拉：选项来源与 ASR 同理（实时目录 + 官方清单兜底）。 */
const ttsModels = ref<{ value: string; label: string }[]>([])
const ttsModelHint = ref('')

async function loadTtsModels(): Promise<void> {
  ttsModelHint.value = ''
  try {
    const parts = ['provider=builtin', 'capability=tts']
    const res = await secureRequest({
      url: `${resolveGatewayHttpBase()}/api/admin/voice-models?${parts.join('&')}`,
      method: 'GET',
    })
    const data = res.data as { models?: string[] } | null
    if (res.statusCode >= 200 && res.statusCode < 300 && data && Array.isArray(data.models)) {
      ttsModels.value = [USE_SOURCE_DEFAULT.value, ...data.models.map((m) => ({ value: m, label: m }))]
      const s = currentProviderSettings()
      if (s.ttsModel && !data.models.includes(s.ttsModel)) s.ttsModel = ''
    } else {
      ttsModels.value = [USE_SOURCE_DEFAULT.value]
      ttsModelHint.value = t('settings.voice.ttsModelEmpty')
    }
  } catch (e) {
    ttsModels.value = [USE_SOURCE_DEFAULT.value]
    ttsModelHint.value = t('settings.voice.ttsModelFailed')
  }
}

/** 一键检测：探测内置来源的 LLM / ASR / TTS / 外网是否正常。
 *  结果反映未保存的编辑（url / apiKey 直接读 appConfig），可先测后存。 */
const detecting = ref(false)
const detectItems = ref<HealthItem[] | null>(null)
const detectError = ref(false)

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

/** 定时检查：开关默认关闭，开启后本页按配置的间隔自动重跑检测、刷新结果。
 *  间隔可选 10/30/60/120 秒（见 AUTO_CHECK_INTERVAL_OPTIONS）。
 *  只在语音设置页打开期间生效，离开页面即清理定时器，不在全局后台跑。 */
// 用 computed 包：t() 的 label 随语言切换重算，别像以前那样在模块加载时固化成单一语言
const autoCheckIntervalOptions = computed(() => AUTO_CHECK_INTERVAL_OPTIONS.map((ms) => ({
  value: String(ms),
  label: t('settings.voice.autoCheckInterval', { seconds: String(ms / 1000) }),
})))
let autoCheckTimer: ReturnType<typeof setInterval> | null = null
function stopAutoCheck(): void {
  if (autoCheckTimer) {
    clearInterval(autoCheckTimer)
    autoCheckTimer = null
  }
}
function startAutoCheck(): void {
  stopAutoCheck()
  if (!appConfig.general.autoCheck) return
  autoCheckTimer = setInterval(() => void runDetection(), appConfig.general.autoCheckMs ?? 30_000)
}
function onAutoCheckChange(on: boolean): void {
  appConfig.general.autoCheck = on
  persistConfig()
  startAutoCheck()
}
function onAutoCheckIntervalChange(ms: string): void {
  appConfig.general.autoCheckMs = Number(ms)
  persistConfig()
  startAutoCheck() // 间隔变了：按新间隔重启定时器
}
onUnmounted(stopAutoCheck)

// duck 强度档位选项（与 duckLevel 配置对应）
// 用 computed 包：档位 label 随语言切换重算，否则切换语言后仍是加载时的旧语言（真机：中文界面显示英文值）
const duckLevelOptions = computed(() => DUCK_LEVEL_OPTIONS.map((level) => ({
  value: level,
  label: t(`settings.general.duck${level.charAt(0).toUpperCase()}${level.slice(1)}`),
})))
function onDuckLevelChange(v: string): void {
  appConfig.general.duckLevel = v as DuckLevel
  persistConfig()
  applyDuckConfig()
  refreshDuckVolume() // 播报中改档位：背景音乐音量立即按新档位生效
}
function onInterruptDuckChange(on: boolean): void {
  appConfig.general.interruptDuck = on
  persistConfig()
  applyDuckConfig()
}
function onBargeInChange(on: boolean): void {
  appConfig.general.bargeIn = on
  persistConfig()
  applyDuckConfig()
}
function onAecChange(on: boolean): void {
  appConfig.general.aecEnabled = on
  persistConfig()
  applyDuckConfig()
}
/** MCP 总开关：关闭后下次 start / 重武装不再下发 MCP server；提示随会话生效。 */
function onMcpEnabledChange(e: any): void {
  appConfig.mcp.enabled = e.detail.value === true
  persistConfig()
}
/** MCP 固定对接 server 的传输协议：http（Streamable HTTP，默认）/ sse（长连接）。下次会话生效。 */
const mcpTransportOptions = computed(() => [
  { value: 'http', label: t('settings.mcp.transport.http') },
  { value: 'sse', label: t('settings.mcp.transport.sse') },
])
function onMcpTransportChange(v: string): void {
  appConfig.mcp.transport = v === 'sse' ? 'sse' : 'http'
  persistConfig()
}
/** MCP 连接失败重试次数：0=不重试，最多 10 次。下次会话生效（网关按此重连 MCP server）。 */
const mcpRetryOptions = computed(() =>
  [0, 1, 2, 3, 5, 10].map((n) => ({
    value: String(n),
    label: n === 0 ? t('settings.mcp.retryNone') : t('settings.mcp.retryTimes', { count: n }),
  }))
)
function onMcpRetryChange(v: string): void {
  const n = Number(v)
  appConfig.mcp.retryCount = Number.isInteger(n) && n >= 0 && n <= 10 ? n : 2
  persistConfig()
}
/** 打开 MCP 已注册工具列表页（网关从固定 server 发现的工具清单）。 */
function openMcpTools(): void {
  uni.navigateTo({ url: '/pages/mcptools/mcptools' })
}
/** Skill 动态加载总开关：关闭后下次 start 不再从 19529 拉 skill 注入 systemPrompt。 */
function onSkillEnabledChange(e: any): void {
  appConfig.skill.enabled = e.detail.value === true
  persistConfig()
}
const skillRetryOptions = computed(() =>
  [0, 1, 2, 3, 5, 10].map((n) => ({
    value: String(n),
    label: n === 0 ? t('settings.mcp.retryNone') : t('settings.mcp.retryTimes', { count: n }),
  }))
)
function onSkillRetryChange(v: string): void {
  const n = Number(v)
  appConfig.skill.retryCount = Number.isInteger(n) && n >= 0 && n <= 10 ? n : 2
  persistConfig()
}
/** 远端 skill 列表（从网关 /api/skills 拉）：进入设置页或点刷新时加载。 */
const remoteSkills = ref<GatewaySkill[]>([])
const skillLoading = ref(false)
const skillError = ref('')
const expandedSkill = ref('')
function toggleSkillExpand(name: string): void {
  expandedSkill.value = expandedSkill.value === name ? '' : name
}
async function loadRemoteSkills(): Promise<void> {
  skillLoading.value = true
  skillError.value = ''
  const res = await fetchGatewaySkills()
  remoteSkills.value = res.skills
  if (!res.ok) skillError.value = res.error || t('settings.skill.loadFail')
  skillLoading.value = false
}
/** 打开通用账号本：按 type 保存账号密码 / API Key，工具按前缀自动取用。 */
function openAccounts(): void {
  uni.navigateTo({ url: '/pages/accounts/accounts' })
}
/** 把配置下发到原生（duck 强度 + 中断前 duck + 插话 + AEC）。UI 改动即生效，不必重启。 */
function applyDuckConfig(): void {
  try {
    setDuckConfig(
      appConfig.general.interruptDuck !== false,
      DUCK_LEVEL_PERCENT[appConfig.general.duckLevel ?? 'medium'],
      appConfig.general.bargeIn === true,
    )
    setAecUserEnabled(appConfig.general.aecEnabled === true)
  } catch { /* 旧基座无此接口，忽略 */ }
}

/** 音色下拉：选项来自网关的固定精选目录（内置=Edge-TTS 常用），不实时拉取以便国际化。
 *  每条带 model（所属模型），渲染成下拉里的次要列，并随选择下发网关决定真正请求的 TTS 模型。 */
const ttsVoices = ref<{ value: string; label: string; subtitle?: string; desc?: string }[]>([])
/** value -> 所属模型 的映射，选中时把对应模型写进配置，随 params.model 下发。 */
const voiceModelMap = new Map<string, string>()
const ttsVoiceHint = ref('')

async function loadTtsVoices(): Promise<void> {
  ttsVoiceHint.value = ''
  voiceModelMap.clear()
  try {
    // 纯字符串拼接，不依赖 URLSearchParams（App 逻辑层 Web API 支持不齐）。
    // 选了 TTS 模型就带 model（音色下拉只显示该模型下的音色），没选就不带。
    const parts = [`provider=builtin`, `lang=${encodeURIComponent(appConfig.language)}`]
    const ttsModel = appConfig.voice.builtin.ttsModel?.trim()
    if (ttsModel) parts.push(`model=${encodeURIComponent(ttsModel)}`)
    const res = await secureRequest({
      url: `${resolveGatewayHttpBase()}/api/admin/tts-voices?${parts.join('&')}`,
      method: 'GET',
    })
    const data = res.data as {
      default?: string
      defaultVoice?: string
      defaultModel?: string
      voices?: Array<{
        id?: string
        value?: string
        label?: string
        model?: string
        descZh?: string
        descEn?: string
        isDefault?: boolean
      }>
    } | null
    if (res.statusCode >= 200 && res.statusCode < 300 && data && Array.isArray(data.voices) && data.voices.length) {
      const en = appConfig.language.toLowerCase().startsWith('en')
      // 首项「沿用来源默认」空值：不选音色时由 9529 按当前模型兜底（如 deepseek-tts→stella）。
      ttsVoices.value = [{ ...USE_SOURCE_DEFAULT.value }]
      ttsVoices.value.push(...data.voices.map((m) => {
        const id = m.id ?? m.value ?? ''
        voiceModelMap.set(id, m.model ?? '')
        // 主标签即 id/名称，desc_zh / desc_en 作为描述副行展示。
        const label = m.label ?? id
        const desc = en ? (m.descEn ?? '') : (m.descZh ?? '')
        return { value: id, label, subtitle: m.model || undefined, desc: desc || undefined }
      }))
      // 不前端强制默认：用户可以不选，未选时由 9529 内部兜底默认音色；仅当已选音色已不在列表里才清空，避免下发非法音色。
      const s = currentProviderSettings()
      if (s.voice && !data.voices.some((v) => (v.id ?? v.value) === s.voice)) {
        s.voice = ''
        s.voiceModel = ''
      }
    } else {
      ttsVoices.value = []
      ttsVoiceHint.value = t('settings.voice.ttsVoiceEmpty')
    }
  } catch (e) {
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

/** 切换 TTS 模型：重选后音色下拉只显示新模型下的音色，旧的非法音色要清掉。 */
function onSelectTtsModel(value: string): void {
  appConfig.voice.builtin.ttsModel = value
  const s = currentProviderSettings()
  s.voice = ''
  s.voiceModel = ''
  void loadTtsVoices()
}

/** 跳转到独立的「长期记忆」分页列表页。 */
function openLongMemory(): void {
  uni.navigateTo({ url: '/pages/longmemory/longmemory' })
}

// 返回：有上一级（如从首页进入）走 navigateBack；直链/刷新进入（无上一级）兜底回首页。
const { goBack } = useSubPageBack({ fallbackUrl: '/pages/index/index' })

// 状态栏让位已收口到 SubPageNav（统一用系统 statusBarHeight 注入顶部留白），本页无需再处理。

onMounted(() => {
  void loadLlmModels()
  void loadTtsVoices()
  void loadAsrModels()
  void loadTtsModels()
  void loadRemoteSkills()
  // 上次开了定时检查：进本页即按配置间隔续上定时器（离开页面 onUnmounted 会清）。
  startAutoCheck()
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
  <view class="page" :style="themeStyle" :data-theme="dataTheme">
    <SubPageNav :title="t('app.settings')" @back="goBack" />
    <!-- 通用设置（语言 / 时区） -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('general')">
        <text class="group-title">{{ t('settings.general.title') }}</text>
        <view class="group-chevron" :class="{ open: isOpen('general') }" />
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
        <!-- 我的账号（原账号管理分组，已并入通用设置）：按 type 保存凭据，工具按前缀取用 -->
        <view class="entry" @tap="openAccounts">
          <view class="row-text">
            <text class="row-label">{{ t('settings.account.manage') }}</text>
            <text class="hint">{{ t('settings.account.manageHint') }}</text>
          </view>
          <text class="entry-arrow">›</text>
        </view>
      </template>
    </view>
    <!-- 语音服务（ASR / LLM / TTS 共用一份配置） -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('voice')">
        <text class="group-title">{{ t('settings.voice.title') }}</text>
        <view class="group-chevron" :class="{ open: isOpen('voice') }" />
      </view>
      <template v-if="isOpen('voice')">
      <!-- 服务来源固定为「内置」（本地 9529），不暴露选择器；默认即内置，onMounted 兜底非法值回内置。 -->

      <!-- 内置：地址与密钥都可改，默认指向本机本地 AI 服务（9529） -->
      <view v-if="appConfig.voice.provider === 'builtin'" class="row column">
        <text class="row-label">{{ t('settings.voice.url') }}</text>
        <input
          class="input"
          v-model="appConfig.voice.builtin.url"
        />
        <text class="row-label">{{ t('settings.voice.apiKey') }}</text>
        <input
          class="input"
          :password="true"
          v-model="appConfig.voice.builtin.apiKey"
        />
        <text class="row-label">{{ t('settings.voice.llmModel') }}</text>
        <SelectRow
          :options="llmModels"
          :model-value="appConfig.voice.builtin.model ?? ''"
          :disabled="llmModels.length === 0"
          :searchable="llmModels.length > 1"
          @update:model-value="(v: string) => (appConfig.voice.builtin.model = v)"
        />
        <!-- 深度思考（推理链）：仅推理模型有效，开了随请求下发 think=true 由语音服务翻译 -->
        <view class="setting-row">
          <view class="setting-text">
            <text class="row-label">{{ t('settings.voice.think') }}</text>
            <text class="hint">{{ t('settings.voice.thinkHint') }}</text>
          </view>
          <switch
            :checked="appConfig.voice.builtin.think ?? false"
            color="#6c8cff"
            @change="(e: any) => (appConfig.voice.builtin.think = e.detail.value)"
          />
        </view>
        <text class="row-label">{{ t('settings.voice.asrModel') }}</text>
        <SelectRow
          :options="asrModels"
          :model-value="appConfig.voice.builtin.asrModel ?? ''"
          :disabled="asrModels.length === 0"
          :searchable="asrModels.length > 1"
          @update:model-value="(v: string) => (appConfig.voice.builtin.asrModel = v)"
        />
        <text class="row-label">{{ t('settings.voice.ttsModel') }}</text>
        <SelectRow
          :options="ttsModels"
          :model-value="appConfig.voice.builtin.ttsModel ?? ''"
          :disabled="ttsModels.length === 0"
          :searchable="ttsModels.length > 1"
          @update:model-value="onSelectTtsModel"
        />
        <text class="row-label">{{ t('settings.voice.ttsVoice') }}</text>
        <SelectRow
          :options="ttsVoices"
          :model-value="appConfig.voice.builtin.voice ?? ''"
          :disabled="ttsVoices.length === 0"
          :searchable="ttsVoices.length > 0"
          @update:model-value="onSelectVoice"
        />
      </view>

      <!-- 恢复默认 + 一键检测同一行：检测按钮在最右侧 -->
      <view class="voice-actions">
        <button class="reset" @tap="onResetVoice">{{ t('settings.reset') }}</button>
        <button class="detect-btn" :disabled="detecting" @tap="runDetection">
          {{ detecting ? t('settings.voice.detecting') : t('settings.voice.detect') }}
        </button>
      </view>
      <text class="hint">{{ t('settings.voice.detectHint') }}</text>
      <!-- 定时检查：默认关闭，开启后本页每 30s 自动重跑检测 -->
      <view class="setting-row">
        <view class="setting-text">
          <text class="row-label">{{ t('settings.voice.autoCheck') }}</text>
          <text class="hint">{{ t('settings.voice.autoCheckHint') }}</text>
        </view>
        <switch
          :checked="appConfig.general.autoCheck ?? false"
          color="#6c8cff"
          @change="(e: any) => onAutoCheckChange(e.detail.value)"
        />
      </view>
      <!-- 定时检查间隔：开关开启时才显示；与其它下拉一致平铺（title 交给 SelectRow），避免被 setting-row 左右布局挤窄 -->
      <template v-if="appConfig.general.autoCheck">
        <text class="row-label">{{ t('settings.voice.autoCheckIntervalLabel') }}</text>
        <SelectRow
          :options="autoCheckIntervalOptions"
          :model-value="String(appConfig.general.autoCheckMs ?? 30000)"
          @update:model-value="onAutoCheckIntervalChange"
        />
      </template>
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
    <!-- 对话设置：音频/定稿/断句/退下 + 超时预算，默认折叠；超时项已并入本分组，位于播放设置之前 -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('dialog')">
        <text class="group-title">{{ t('settings.dialog.title') }}</text>
        <view class="group-chevron" :class="{ open: isOpen('dialog') }" />
      </view>
      <template v-if="isOpen('dialog')">
        <!-- 音频开关放最前，展开对话设置即可见（之前在服务设置，用户以为没了） -->
        <!-- 中断前 duck：播报中检测人声开口时压低播报/媒体给 KWS 让路（打断/插话都适用） -->
        <view class="setting-row">
          <view class="setting-text">
            <text class="row-label">{{ t('settings.general.interruptDuck') }}</text>
            <text class="hint">{{ t('settings.general.interruptDuckHint') }}</text>
          </view>
          <switch
            :checked="appConfig.general.interruptDuck !== false"
            color="#6c8cff"
            @change="(e: any) => onInterruptDuckChange(e.detail.value)"
          />
        </view>
        <!-- duck 强度：三种 duck 共用的压低程度；与其它下拉一致用 sub 容器平铺 -->
        <view class="sub">
          <SelectRow
            :title="t('settings.general.duckLevel')"
            :hint="t('settings.general.duckLevelHint')"
            :options="duckLevelOptions"
            :model-value="appConfig.general.duckLevel ?? 'medium'"
            @update:model-value="onDuckLevelChange"
          />
        </view>
        <!-- 插话开关：默认关（播报期静音、只靠 KWS 打断）；开则恢复播报期上行+插话入队 -->
        <view class="setting-row">
          <view class="setting-text">
            <text class="row-label">{{ t('settings.general.bargeIn') }}</text>
            <text class="hint">{{ t('settings.general.bargeInHint') }}</text>
          </view>
          <switch
            :checked="appConfig.general.bargeIn === true"
            color="#6c8cff"
            @change="(e: any) => onBargeInChange(e.detail.value)"
          />
        </view>
        <!-- 硬件 AEC 开关：开=采集全程用系统 AEC（含播报期），默认开启；四场景实验证明不影响唤醒命中率 -->
        <view class="setting-row">
          <view class="setting-text">
            <text class="row-label">{{ t('settings.playback.aecEnabled') }}</text>
            <text class="hint">{{ t('settings.playback.aecEnabledHint') }}</text>
          </view>
          <switch
            :checked="appConfig.general.aecEnabled === true"
            color="#6c8cff"
            @change="(e: any) => onAecChange(e.detail.value)"
          />
        </view>
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.playback.finalizeMaxChars') }}</text>
          <input class="input" type="number" v-model.number="appConfig.playback.finalizeMaxChars" />
          <text class="hint">{{ t('settings.playback.finalizeMaxCharsHint') }}</text>
        </view>
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.playback.finalizeTimeoutMs') }}</text>
          <input class="input" type="number" v-model.number="appConfig.playback.finalizeTimeoutMs" />
          <text class="hint">{{ t('settings.playback.finalizeTimeoutMsHint') }}</text>
        </view>
        <!-- 播报断句：遇标点即切、并行合成，限制并发数 -->
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.playback.ttsConcurrency') }}</text>
          <input class="input" type="number" v-model.number="appConfig.playback.ttsConcurrency" />
          <text class="hint">{{ t('settings.playback.ttsConcurrencyHint') }}</text>
        </view>
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.playback.autoExitMs') }}</text>
          <input class="input" type="number" v-model.number="appConfig.playback.autoExitMs" />
          <text class="hint">{{ t('settings.playback.autoExitMsHint') }}</text>
        </view>
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.playback.autoExitGraceMs') }}</text>
          <input class="input" type="number" v-model.number="appConfig.playback.autoExitGraceMs" />
          <text class="hint">{{ t('settings.playback.autoExitGraceMsHint') }}</text>
        </view>

        <!-- 超时设置（原独立分组，已并入对话设置） -->
        <text class="hint">{{ t('settings.timeout.sub') }}</text>
        <!-- 定稿识别超时：一句话说完等这么久还没出结果就按现有文字定稿，超时短了会识别不出字 -->
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.timeout.asrFinalizeMs') }}</text>
          <input
            class="input"
            type="number"
            v-model.number="appConfig.timeouts.asrFinalizeMs"
            @blur="onTimeoutBlur"
          />
          <text class="hint">{{ t('settings.timeout.asrFinalizeMsHint') }}</text>
        </view>
        <!-- 中间识别间隔：界面实时字幕多久刷新一次，越短越跟手、越费算力 -->
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.timeout.asrPartialIntervalMs') }}</text>
          <input
            class="input"
            type="number"
            v-model.number="appConfig.timeouts.asrPartialIntervalMs"
            @blur="onTimeoutBlur"
          />
          <text class="hint">{{ t('settings.timeout.asrPartialIntervalMsHint') }}</text>
        </view>
        <!-- 单轮回复超时：问完到拿到回答的上限，思考模式下另有更长预算 -->
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.timeout.llmMs') }}</text>
          <input
            class="input"
            type="number"
            v-model.number="appConfig.timeouts.llmMs"
            @blur="onTimeoutBlur"
          />
          <text class="hint">{{ t('settings.timeout.llmMsHint') }}</text>
        </view>
        <!-- 单次播报合成超时：整句合成语音的总预算，含失败重试 -->
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.timeout.ttsMs') }}</text>
          <input
            class="input"
            type="number"
            v-model.number="appConfig.timeouts.ttsMs"
            @blur="onTimeoutBlur"
          />
          <text class="hint">{{ t('settings.timeout.ttsMsHint') }}</text>
        </view>
        <!-- 播报卡顿断开：这么久没收到新的音频帧就判定卡死并收尾 -->
        <view class="setting-row column">
          <text class="row-label">{{ t('settings.timeout.ttsFrameGapMs') }}</text>
          <input
            class="input"
            type="number"
            v-model.number="appConfig.timeouts.ttsFrameGapMs"
            @blur="onTimeoutBlur"
          />
          <text class="hint">{{ t('settings.timeout.ttsFrameGapMsHint') }}</text>
        </view>

        <button class="reset" @tap="onResetDialog">{{ t('settings.reset') }}</button>
      </template>
    </view>
    <!-- 播放设置（音乐播放源等），默认折叠 -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('playback')">
        <text class="group-title">{{ t('settings.playback.title') }}</text>
        <view class="group-chevron" :class="{ open: isOpen('playback') }" />
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
    <!-- 好价设置（好价商品推荐条数），默认折叠，位于播放设置之后 -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('recommend')">
        <text class="group-title">{{ t('settings.recommend.title') }}</text>
        <view class="group-chevron" :class="{ open: isOpen('recommend') }" />
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

        <!-- 好价商品列表入口：查看助手推荐过的商品（持久化，仿收藏） -->
        <view class="entry" @tap="openDeals">
          <text class="entry-label">{{ t('settings.recommend.deals') }}</text>
          <text class="entry-arrow">›</text>
        </view>
      </template>
    </view>
    <!-- 记忆设置：自动记忆开关 + 长期记忆入口（独立分页列表页） -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('memory')">
        <text class="group-title">{{ t('settings.memory.title') }}</text>
        <view class="group-chevron" :class="{ open: isOpen('memory') }" />
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
    <!-- MCP 总开关：关闭则不向网关下发任何 MCP server（整体停用）。MCP 固定对接服务地址下的
         /mcp/（Streamable HTTP）或 /mcp/sse（SSE，按下面的协议选择），无手动服务器列表；
         保存/下次会话生效。 -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('mcp')">
        <text class="group-title">{{ t('settings.mcp.title') }}</text>
        <view class="group-chevron" :class="{ open: isOpen('mcp') }" />
      </view>
      <template v-if="isOpen('mcp')">
        <view class="setting-row">
          <view class="row-text">
            <text class="row-label">{{ t('settings.mcp.enabled') }}</text>
            <text class="hint">{{ t('settings.mcp.enabledHint') }}</text>
          </view>
          <switch
            class="setting-switch"
            :checked="appConfig.mcp.enabled"
            color="#6c8cff"
            @change="onMcpEnabledChange"
          />
        </view>
        <text class="row-label">{{ t('settings.mcp.transport.title') }}</text>
        <SelectRow
          :options="mcpTransportOptions"
          :model-value="appConfig.mcp.transport"
          @update:model-value="onMcpTransportChange"
        />
        <text class="hint">{{ t('settings.mcp.transportHint') }}</text>
        <text class="row-label">{{ t('settings.mcp.retry.title') }}</text>
        <SelectRow
          :options="mcpRetryOptions"
          :model-value="String(appConfig.mcp.retryCount)"
          @update:model-value="onMcpRetryChange"
        />
        <text class="hint">{{ t('settings.mcp.retryHint') }}</text>
        <view class="entry" @tap="openMcpTools">
          <view class="row-text">
            <text class="row-label">{{ t('settings.mcp.toolsEntry') }}</text>
            <text class="hint">{{ t('settings.mcp.toolsEntryHint') }}</text>
          </view>
          <text class="entry-arrow">›</text>
        </view>
      </template>
    </view>
    <!-- Skill 设置：动态加载 19529 上的 skill（开关 + 重试次数 + 实时列表），和 MCP 类似 -->
    <view class="group">
      <view class="group-head" @tap="toggleGroup('skill')">
        <text class="group-title">{{ t('settings.skill.title') }}</text>
        <view class="group-chevron" :class="{ open: isOpen('skill') }" />
      </view>
      <template v-if="isOpen('skill')">
        <text class="hint">{{ t('settings.skill.sub') }}</text>
        <view class="setting-row">
          <view class="row-text">
            <text class="row-label">{{ t('settings.skill.enabled') }}</text>
            <text class="hint">{{ t('settings.skill.enabledHint') }}</text>
          </view>
          <switch
            class="setting-switch"
            :checked="appConfig.skill.enabled"
            color="#6c8cff"
            @change="onSkillEnabledChange"
          />
        </view>
        <text class="row-label">{{ t('settings.skill.retry.title') }}</text>
        <SelectRow
          :options="skillRetryOptions"
          :model-value="String(appConfig.skill.retryCount)"
          @update:model-value="onSkillRetryChange"
        />
        <text class="hint">{{ t('settings.skill.retryHint') }}</text>
        <!-- 已加载的 skill 列表：从网关 /api/skills 实时拉，列出 name + 说明 -->
        <view class="skill-list-head">
          <text class="row-label">{{ t('settings.skill.listTitle') }}</text>
          <text class="refresh" @tap="loadRemoteSkills">{{ t('settings.skill.refresh') }}</text>
        </view>
        <text v-if="skillLoading" class="hint">{{ t('settings.skill.loading') }}</text>
        <text v-else-if="skillError" class="hint hint-err">{{ skillError }}</text>
        <text v-else-if="!remoteSkills.length" class="hint">{{ t('settings.skill.empty') }}</text>
        <view v-else class="skill-list">
          <view v-for="s in remoteSkills" :key="s.name" class="skill-item">
            <!-- 点标题行展开/收起正文（与 19529 管理页「预览正文」一致） -->
            <view class="skill-item-head" @tap="toggleSkillExpand(s.name)">
              <text class="skill-name">{{ s.name }}</text>
              <text class="skill-toggle">{{ expandedSkill === s.name ? '▾' : '▸' }}</text>
            </view>
            <text v-if="s.description" class="skill-desc">{{ s.description }}</text>
            <text v-if="expandedSkill === s.name" class="skill-content">{{ s.content || t('settings.skill.noContent') }}</text>
          </view>
        </view>
      </template>
    </view>
    <!-- 保存配置 + 重启网关 并列 -->
    <view class="footer-actions">
      <button class="save" :disabled="saving" @tap="onSave">{{ t('settings.save') }}</button>
      <button class="restart-btn" :disabled="gatewayRestarting" @tap="askRestartGateway">{{ t('settings.gateway.restart') }}</button>
    </view>
    <!-- 重启网关确认条：红色警示，说明+确认/取消，确认才真的重启（避免误触） -->
    <view v-if="gatewayRestartConfirm" class="restart-confirm">
      <text class="restart-confirm-text">{{ t('settings.gateway.restartHint') }}</text>
      <view class="restart-confirm-actions">
        <button class="restart-confirm-cancel" @tap="cancelRestartGateway">{{ t('settings.gateway.restartCancel') }}</button>
        <button class="restart-confirm-ok" :disabled="gatewayRestarting" @tap="onRestartGateway">{{ t('settings.gateway.restartConfirm') }}</button>
      </view>
    </view>
    <text v-if="gatewayRestartMsg" class="restart-msg">{{ gatewayRestartMsg }}</text>
    <!-- 仅失败时行内红字报错：连不上网关要如实告知，不谎报成功；成功不显示文字 -->
    <text v-if="saveFailed" class="save-status save-err">{{ t('settings.saveFailGateway') }}{{ saveErrDetail }}</text>

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
  letter-spacing: 0.3px;
  color: var(--accent);
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 2px;
  cursor: pointer;
}

.sub {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-chevron {
  width: 8px;
  height: 8px;
  border-right: 1.5px solid var(--accent);
  border-bottom: 1.5px solid var(--accent);
  transform: rotate(-45deg);
  transition: transform 0.2s ease;
  opacity: 0.85;
  flex-shrink: 0;
}

.group-chevron.open {
  transform: rotate(45deg);
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

/* 主题色板：等分铺满整行，不留右侧空白；auto-fit + minmax(0,1fr) 让若干色卡在一行内均分宽度，
   主题数量变化时也自动铺满（不出现定宽导致的右侧留白）。 */
.theme-swatches {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
  gap: 10px;
  margin-top: 4px;
}

.theme-swatch {
  position: relative;
  width: 100%;
  height: 56px;
  border-radius: 12px;
  border: 2px solid transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  overflow: hidden;
  cursor: pointer;
}

.theme-swatch.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}

.swatch-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
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

.save-status {
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  color: #ff6b81;
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
  color: var(--accent);
  background: rgba(var(--accent-rgb), 0.1);
  border: 1px solid rgba(var(--accent-rgb), 0.4);
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

/* 保存配置 + 重启网关 并列 */
.footer-actions {
  display: flex;
  flex-direction: row;
  gap: 10px;
  width: 100%;
  margin-top: 4px;
}
.footer-actions .save {
  flex: 1;
  width: auto;
  min-width: 0;
  box-sizing: border-box;
  margin-top: 0;
}
.restart-btn {
  flex: 1;
  width: auto;
  min-width: 0;
  box-sizing: border-box;
  margin: 0;
  height: 44px;
  line-height: 44px;
  padding: 0;
  border-radius: 22px;
  font-size: 14px;
  font-weight: 600;
  color: #ff6b81;
  background: rgba(255, 107, 129, 0.1);
  border: 1px solid rgba(255, 107, 129, 0.5);
}
.restart-btn::after { border: none; }

/* 重启确认条：红色警示 */
.restart-confirm {
  width: 100%;
  margin-top: 10px;
  padding: 12px;
  box-sizing: border-box;
  border-radius: 12px;
  background: rgba(255, 107, 129, 0.08);
  border: 1px solid rgba(255, 107, 129, 0.4);
}
.restart-confirm-text {
  display: block;
  font-size: 12px;
  line-height: 1.6;
  color: #ff8a9b;
}
.restart-confirm-actions {
  display: flex;
  flex-direction: row;
  gap: 10px;
  margin-top: 10px;
}
.restart-confirm-cancel, .restart-confirm-ok {
  flex: 1;
  margin: 0;
  height: 36px;
  line-height: 36px;
  border-radius: 10px;
  font-size: 13px;
}
.restart-confirm-cancel {
  color: #aab0c4;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.15);
}
.restart-confirm-ok {
  color: #fff;
  background: #e5484d;
  border: none;
  font-weight: 600;
}
.restart-confirm-cancel::after, .restart-confirm-ok::after { border: none; }
.restart-msg {
  display: block;
  width: 100%;
  margin-top: 8px;
  text-align: center;
  font-size: 12px;
  line-height: 1.5;
  color: #7fd6a8;
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

/* Skill 设置：列表 + 刷新 */
.skill-list-head { display: flex; flex-direction: row; align-items: center; justify-content: space-between; }
.refresh { font-size: 12px; color: #6c8cff; }
.hint-err { color: #ff6b9d; }
.skill-list { display: flex; flex-direction: column; gap: 6px; }
.skill-item { padding: 8px 10px; background: rgba(255, 255, 255, 0.05); border-radius: 8px; }
.skill-item-head { display: flex; flex-direction: row; align-items: center; justify-content: space-between; }
.skill-name { font-size: 12px; color: #9be8cd; font-weight: 600; }
.skill-toggle { font-size: 12px; color: #6c8cff; }
/* 正文：多行完整显示，和 19529 管理页「预览正文」一致 */
.skill-content {
  display: block; margin-top: 8px; padding: 8px; background: rgba(0, 0, 0, 0.2);
  border-radius: 6px; font-size: 11px; color: #b9bed6; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
/* Skill 说明：多行文本完整显示（description 可能是长句，不单行截断） */
.skill-desc {
  display: block;
  font-size: 11px;
  color: #9aa1bd;
  margin-top: 4px;
  line-height: 1.6;
  white-space: normal;
  word-break: break-all;
}

/* 横屏：确保页面铺满宽度，避免左右留白 */
@media (orientation: landscape) {
  .page {
    max-width: none;
  }
}
</style>
