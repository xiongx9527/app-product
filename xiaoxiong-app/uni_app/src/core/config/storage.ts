import {
  DEFAULT_LANGUAGE,
  DEFAULT_TIMEZONE,
  normalizeTimezone,
  SUBTITLE_FONT_SIZE_OPTIONS,
  SUBTITLE_COLOR_OPTIONS,
  DEFAULT_SUBTITLE_FONT_SIZE,
  DEFAULT_SUBTITLE_COLOR,
  AUTO_CHECK_INTERVAL_OPTIONS,
  DEFAULT_AUTO_CHECK_MS,
  DUCK_LEVEL_OPTIONS,
  DEFAULT_DUCK_LEVEL,
} from './constants'
import { FLOAT_POSITION_PRESETS, type FloatPositionKey } from '../adaptation/floatLayer'
import type { AppConfig, GeneralConfig, MemoryConfig, McpConfig, McpServerConfig, McpTransport, PlaybackConfig, PlaybackSource, RecommendConfig, ServiceMode, VoiceProviderKind, VoiceProviderSettings, VoiceServiceConfig } from './types'

export const CONFIG_STORAGE_KEY = 'app-product.config.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 内置语音服务默认根地址：花生壳固定域名（域名永久不变，非 cloudflared 随机域名）。
// cloudflared trycloudflare 域名每次重启都会变，已弃用。
const DEFAULT_BUILTIN_URL = 'https://25946kt718.goho.co'
// 旧默认地址：存量配置里若仍是这些值（且用户没改过），自动迁移到固定域名。
// 包括旧本机端口（9529 已关闭）和旧 cloudflared 随机域名。
const LEGACY_BUILTIN_URL = 'http://127.0.0.1:9529'
const LEGACY_BUILTIN_URL_2 = 'https://foreign-becoming-lucia-consciousness.trycloudflare.com'

const DEFAULT_VOICE: VoiceServiceConfig = {
  provider: 'builtin',
  builtin: { url: DEFAULT_BUILTIN_URL, apiKey: '', model: '', voice: '', voiceModel: '', asrModel: '', ttsModel: '' },
}

/** 默认语音服务：内置、公网语音服务、无需密钥 */
export function createDefaultVoice(): VoiceServiceConfig {
  return {
    provider: DEFAULT_VOICE.provider,
    builtin: { ...DEFAULT_VOICE.builtin },
  }
}

const DEFAULT_PLAYBACK: PlaybackConfig = {
  source: 'baidu',
  autoSave: false,
  autoSubtitle: true,
  defaultLoop: 3,
  autoLoop: false,
  defaultVolume: 0.5,
  // 默认悬浮小圆（酷狗式）：用户明确要求默认打开
  floatPlayer: true,
  floatPosition: 'top-center',
  subtitleFontSize: DEFAULT_SUBTITLE_FONT_SIZE,
  subtitleColor: DEFAULT_SUBTITLE_COLOR,
  finalizeMaxChars: 30,
  finalizeTimeoutMs: 10000,
  autoExitMs: 30000,
  autoExitGraceMs: 15000,
}

/** 默认播放设置：播放源百度，关闭自动收藏，自动字幕开启，关闭自动循环，默认循环 3 次、默认音量 50% */
export function createDefaultPlayback(): PlaybackConfig {
  return {
    source: DEFAULT_PLAYBACK.source,
    autoSave: DEFAULT_PLAYBACK.autoSave,
    autoSubtitle: DEFAULT_PLAYBACK.autoSubtitle,
    defaultLoop: DEFAULT_PLAYBACK.defaultLoop,
    autoLoop: DEFAULT_PLAYBACK.autoLoop,
    defaultVolume: DEFAULT_PLAYBACK.defaultVolume,
    floatPlayer: DEFAULT_PLAYBACK.floatPlayer,
    floatPosition: DEFAULT_PLAYBACK.floatPosition,
    subtitleFontSize: DEFAULT_PLAYBACK.subtitleFontSize,
    subtitleColor: DEFAULT_PLAYBACK.subtitleColor,
    finalizeMaxChars: DEFAULT_PLAYBACK.finalizeMaxChars,
    finalizeTimeoutMs: DEFAULT_PLAYBACK.finalizeTimeoutMs,
    autoExitMs: DEFAULT_PLAYBACK.autoExitMs,
    autoExitGraceMs: DEFAULT_PLAYBACK.autoExitGraceMs,
  }
}

const DEFAULT_RECOMMEND: RecommendConfig = {
  dealsCount: 3,
}

/** 默认推荐设置：好价商品推荐 3 条，范围 1–10。 */
export function createDefaultRecommend(): RecommendConfig {
  return { dealsCount: DEFAULT_RECOMMEND.dealsCount }
}

export function createDefaultConfig(): AppConfig {
  return {
    version: 1,
    mode: 'byok',
    language: DEFAULT_LANGUAGE,
    timezone: DEFAULT_TIMEZONE,
    voice: createDefaultVoice(),
    playback: createDefaultPlayback(),
    recommend: createDefaultRecommend(),
    general: createDefaultGeneral(),
    memory: createDefaultMemory(),
    mcp: createDefaultMcp(),
  }
}

/** 通用设置默认值：自动连接网关默认开启（开屏即连网关进入待唤醒，免去手动点开关）；定时检查默认关闭。 */
function createDefaultGeneral(): GeneralConfig {
  return {
    autoConnect: true, theme: 'default', autoCheck: false, autoCheckMs: DEFAULT_AUTO_CHECK_MS,
    duckLevel: DEFAULT_DUCK_LEVEL, interruptDuck: true, bargeIn: false, aecEnabled: true,
  }
}

const THEME_IDS = ['default', 'purple', 'teal', 'amber'] as const

/** 归一化通用设置：autoConnect 只认 boolean，缺省/非法回退默认（开）；autoCheck 缺省/非法回退默认（关）。 */
function normalizeGeneral(raw: unknown): GeneralConfig {
  const source = isRecord(raw) ? raw : {}
  const autoConnect =
    typeof source.autoConnect === 'boolean' ? source.autoConnect : createDefaultGeneral().autoConnect
  const autoCheck =
    typeof source.autoCheck === 'boolean' ? source.autoCheck : createDefaultGeneral().autoCheck
  const autoCheckMs = AUTO_CHECK_INTERVAL_OPTIONS.includes(source.autoCheckMs as (typeof AUTO_CHECK_INTERVAL_OPTIONS)[number])
    ? (source.autoCheckMs as number)
    : DEFAULT_AUTO_CHECK_MS
  const theme = THEME_IDS.includes(source.theme as (typeof THEME_IDS)[number])
    ? (source.theme as GeneralConfig['theme'])
    : createDefaultGeneral().theme
  const duckLevel = DUCK_LEVEL_OPTIONS.includes(source.duckLevel as (typeof DUCK_LEVEL_OPTIONS)[number])
    ? (source.duckLevel as GeneralConfig['duckLevel'])
    : DEFAULT_DUCK_LEVEL
  const interruptDuck =
    typeof source.interruptDuck === 'boolean' ? source.interruptDuck : createDefaultGeneral().interruptDuck
  const bargeIn =
    typeof source.bargeIn === 'boolean' ? source.bargeIn : createDefaultGeneral().bargeIn
  const aecEnabled =
    typeof source.aecEnabled === 'boolean' ? source.aecEnabled : createDefaultGeneral().aecEnabled
  return { autoConnect, theme, autoCheck, autoCheckMs, duckLevel, interruptDuck, bargeIn, aecEnabled }
}

/** 记忆设置默认值：自动记忆（自动抽取）默认关闭，手动指令不受此开关影响。 */
function createDefaultMemory(): MemoryConfig {
  return { autoMemory: false, consolidateThreshold: 30, consolidateEvery: 5 }
}

/** 记忆设置：合并阈值/频率只认非负整数，缺省/非法回退默认值（30 / 5）。 */
function normalizeMemoryThreshold(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/** 归一化记忆设置：autoMemory 只认 boolean，缺省/非法回退默认（关）。 */
function normalizeMemory(raw: unknown): MemoryConfig {
  const source = isRecord(raw) ? raw : {}
  const autoMemory =
    typeof source.autoMemory === 'boolean' ? source.autoMemory : createDefaultMemory().autoMemory
  const def = createDefaultMemory()
  return {
    autoMemory,
    consolidateThreshold: normalizeMemoryThreshold(source.consolidateThreshold, def.consolidateThreshold),
    consolidateEvery: normalizeMemoryThreshold(source.consolidateEvery, def.consolidateEvery),
  }
}

/** MCP 服务器列表默认值：总开关默认开启（保持与历史行为一致：列表里有启用项即连接），列表为空。 */
function createDefaultMcp(): McpConfig {
  return { enabled: true, servers: [] }
}

const MCP_TRANSPORTS: McpTransport[] = ['stdio', 'sse', 'http']

/**
 * 归一化单个 MCP 服务器配置：name 必须为字符串；transport 只接受 stdio/sse/http，否则丢弃该项；
 * stdio 必须有 command、sse/http 必须有 url，否则丢弃该项（避免下发网关连不上/连错）；
 * enabled 收敛为 boolean（缺省 true）；id 缺失则补一个稳定随机标识（列表 key 与持久化用）。
 */
function normalizeMcpServer(raw: unknown): McpServerConfig | null {
  const source = isRecord(raw) ? raw : {}
  const name = typeof source.name === 'string' ? source.name.trim() : ''
  const transport = (source.transport as McpTransport) ?? 'stdio'
  if (!name || !MCP_TRANSPORTS.includes(transport)) return null
  const id = typeof source.id === 'string' && source.id ? source.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : true
  if (transport === 'stdio') {
    const command = typeof source.command === 'string' ? source.command.trim() : ''
    if (!command) return null
    const args = Array.isArray(source.args) ? source.args.filter((a) => typeof a === 'string') : []
    const env: Record<string, string> | undefined = isRecord(source.env)
      ? Object.fromEntries(
          Object.entries(source.env)
            .filter(([, v]) => typeof v === 'string')
            .map(([k, v]) => [k, v as string])
        )
      : undefined
    return { id, name, enabled, transport, command, args, env }
  }
  const url = typeof source.url === 'string' ? source.url.trim() : ''
  if (!url) return null
  const enabledTools = Array.isArray(source.enabledTools) ? source.enabledTools.filter((t) => typeof t === 'string') : undefined
  const disabledTools = Array.isArray(source.disabledTools) ? source.disabledTools.filter((t) => typeof t === 'string') : undefined
  // sse/http 的鉴权头：仅保留 string→string 的键值对，避免脏数据把请求带崩。
  const headers: Record<string, string> | undefined = isRecord(source.headers)
    ? Object.fromEntries(
        Object.entries(source.headers)
          .filter(([, v]) => typeof v === 'string')
          .map(([k, v]) => [k, v as string])
      )
    : undefined
  return { id, name, enabled, transport, url, headers, enabledTools, disabledTools }
}

/** 归一化 MCP 配置：servers 逐项校验，非法项丢弃；非数组/缺省回退空列表。 */
function normalizeMcp(raw: unknown): McpConfig {
  const source = isRecord(raw) ? raw : {}
  const enabled = typeof source.enabled === 'boolean' ? source.enabled : true
  const list = Array.isArray(source.servers) ? source.servers : []
  const servers = list.map(normalizeMcpServer).filter((s): s is McpServerConfig => s !== null)
  return { enabled, servers }
}

function normalizeProviderSettings(
  raw: unknown,
  fallback: { url: string; apiKey: string; model?: string; voice?: string; voiceModel?: string; asrModel?: string; ttsModel?: string; think?: boolean }
): VoiceProviderSettings {
  const source = isRecord(raw) ? raw : {}
  const url = typeof source.url === 'string' ? source.url.trim() : ''
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey : ''
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  const voice = typeof source.voice === 'string' ? source.voice.trim() : ''
  const voiceModel = typeof source.voiceModel === 'string' ? source.voiceModel.trim() : ''
  const asrModel = typeof source.asrModel === 'string' ? source.asrModel.trim() : ''
  const ttsModel = typeof source.ttsModel === 'string' ? source.ttsModel.trim() : ''
  // 深度思考开关：缺省 false；旧存档没有该字段时按 fallback（也是 false）处理。
  const think = typeof source.think === 'boolean' ? source.think : (fallback.think ?? false)
  return {
    url: url || fallback.url,
    apiKey: apiKey || fallback.apiKey,
    model: model || fallback.model || '',
    voice: voice || fallback.voice || '',
    voiceModel: voiceModel || fallback.voiceModel || '',
    asrModel: asrModel || fallback.asrModel || '',
    ttsModel: ttsModel || fallback.ttsModel || '',
    think,
  }
}

/**
 * 归一化语音服务配置：provider 恒为 builtin（百炼来源已下线）。
 * 兼容旧的单份 url/apiKey 存档（迁移进 builtin）；旧 dashscope 来源配置丢弃。
 */
function normalizeVoice(raw: unknown): VoiceServiceConfig {
  const source = isRecord(raw) ? raw : {}
  const provider: VoiceProviderKind = 'builtin'
  // 旧格式：直接挂在 voice 上的 url / apiKey，迁移到 builtin 这一份。
  // 旧 dashscope 子配置随 provider 下线不再读取（provider 已下线，符合预期）。
  const legacyUrl = typeof source.url === 'string' ? source.url.trim() : ''
  const legacyApiKey = typeof source.apiKey === 'string' ? source.apiKey : ''
  const builtin = normalizeProviderSettings(source.builtin, {
    url: legacyUrl || DEFAULT_VOICE.builtin.url,
    apiKey: legacyApiKey || DEFAULT_VOICE.builtin.apiKey,
  })
  // 存量配置迁移：builtin.url 若仍是出厂旧默认（用户没改过），升级到固定域名。
  // 花生壳仅开发测试用，正式发布时把 DEFAULT_BUILTIN_URL 换成正式公网地址即可。
  // 只精准命中旧默认值，用户自填的其它地址（自建 LAN / 其它服务）一律不动。
  if (builtin.url === LEGACY_BUILTIN_URL || builtin.url === LEGACY_BUILTIN_URL_2) {
    builtin.url = DEFAULT_BUILTIN_URL
  }
  return { provider, builtin }
}

/**
 * 归一化播放设置：source 只接受已知的播放源，其余落回默认百度。
 * 当前仅有百度一个来源，非法值直接回退，避免下发网关不认识的来源。
 */
function normalizePlayback(raw: unknown): PlaybackConfig {
  const source = isRecord(raw) ? raw : {}
  const src = typeof source.source === 'string' ? source.source : ''
  const valid: PlaybackSource[] = ['baidu', 'netease', 'tencent', 'kugou']
  const autoSave = typeof source.autoSave === 'boolean' ? source.autoSave : false
  // 自动字幕：boolean，缺省开启（播放音乐时同源自动拉取并展示字幕）。
  const autoSubtitle = typeof source.autoSubtitle === 'boolean' ? source.autoSubtitle : true
  // 自动循环：boolean，缺省关闭（普通播放只播一遍，循环仅在开关开启或显式指令/手动时生效）。
  const autoLoop = typeof source.autoLoop === 'boolean' ? source.autoLoop : false
  // 默认循环次数：非负整数，缺省/非法回退 3。
  const rawLoop = Number(source.defaultLoop)
  const defaultLoop = Number.isFinite(rawLoop) && rawLoop >= 0 ? Math.floor(rawLoop) : 3
  // 默认音量：夹紧到 0–1，缺省/非法回退 0.5。
  const rawVol = Number(source.defaultVolume)
  const defaultVolume = Number.isFinite(rawVol) ? Math.min(1, Math.max(0, rawVol)) : 0.5
  // 悬浮小圆播放器：boolean，缺省开启（默认悬浮小圆；纯客户端 UI 开关，不下发网关）。
  const floatPlayer = typeof source.floatPlayer === 'boolean' ? source.floatPlayer : true
  // 悬浮位置：只接受通用悬浮层的预设 key，非法/缺省回退「顶部居中」。
  const rawPos = typeof source.floatPosition === 'string' ? source.floatPosition : ''
  const floatPosition: FloatPositionKey =
    rawPos in FLOAT_POSITION_PRESETS ? (rawPos as FloatPositionKey) : 'top-center'
  // 当前字幕字号：只接受预设档位，非法/缺省回退 18。
  const rawFont = Number(source.subtitleFontSize)
  const subtitleFontSize = (SUBTITLE_FONT_SIZE_OPTIONS as readonly number[]).includes(rawFont)
    ? rawFont
    : DEFAULT_SUBTITLE_FONT_SIZE
  // 当前字幕颜色：只接受预设 hex，非法/缺省回退白色。
  const rawColor = typeof source.subtitleColor === 'string' ? source.subtitleColor : ''
  const subtitleColor = (SUBTITLE_COLOR_OPTIONS as readonly string[]).includes(rawColor)
    ? rawColor
    : DEFAULT_SUBTITLE_COLOR
  // partial 兜底定稿：字数上限缺省30(10-200)、有字超时缺省10000ms(2000-60000)，非法回退默认。
  const rawChars = Number(source.finalizeMaxChars)
  const finalizeMaxChars = Number.isFinite(rawChars) && rawChars >= 10
    ? Math.min(200, Math.floor(rawChars)) : 30
  const rawTimeout = Number(source.finalizeTimeoutMs)
  const finalizeTimeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 2000
    ? Math.min(60000, Math.floor(rawTimeout)) : 10000
  // 自动退下时间：T1 静默缺省30000(5000-300000)、T2 宽限缺省15000(3000-120000)。
  const rawExit = Number(source.autoExitMs)
  const autoExitMs = Number.isFinite(rawExit) && rawExit >= 5000
    ? Math.min(300000, Math.floor(rawExit)) : 30000
  const rawGrace = Number(source.autoExitGraceMs)
  const autoExitGraceMs = Number.isFinite(rawGrace) && rawGrace >= 3000
    ? Math.min(120000, Math.floor(rawGrace)) : 15000
  return {
    source: valid.includes(src as PlaybackSource) ? (src as PlaybackSource) : 'baidu',
    autoSave,
    autoSubtitle,
    defaultLoop,
    autoLoop,
    defaultVolume,
    floatPlayer,
    floatPosition,
    subtitleFontSize,
    subtitleColor,
    finalizeMaxChars,
    finalizeTimeoutMs,
    autoExitMs,
    autoExitGraceMs,
  }
}

/**
 * 归一化推荐设置：dealsCount 只接受 1–10 的整数，缺省/非法回退 3。
 * 与网关工具上限一致（好价工具收敛到 1–10），避免下发网关不认识的条数。
 */
function normalizeRecommend(raw: unknown): RecommendConfig {
  const source = isRecord(raw) ? raw : {}
  const toCount = (v: unknown, fallback: number): number => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.min(10, Math.max(1, Math.floor(n)))
  }
  return {
    dealsCount: toCount(source.dealsCount, DEFAULT_RECOMMEND.dealsCount),
  }
}

/** 读取任意输入并补齐缺失项；存档损坏时也能得到一份可用配置 */
export function normalizeConfig(
  input: unknown,
  base: AppConfig = createDefaultConfig()
): AppConfig {
  const source = isRecord(input) ? input : {}
  const mode: ServiceMode = source.mode === 'platform' ? 'platform' : 'byok'
  const language =
    typeof source.language === 'string' && source.language.trim()
      ? source.language
      : base.language
  const timezone = normalizeTimezone(source.timezone ?? base.timezone)

  // 旧的 asr / llm / tts 字段直接丢弃，不迁移、不兼容；voice 缺失补默认
  const voice = normalizeVoice(source.voice ?? base.voice)
  const playback = normalizePlayback(source.playback ?? base.playback)
  const recommend = normalizeRecommend(source.recommend ?? base.recommend)
  const general = normalizeGeneral(source.general ?? base.general)
  const memory = normalizeMemory(source.memory ?? base.memory)
  const mcp = normalizeMcp(source.mcp ?? base.mcp)

  return { version: 1, mode, language, timezone, voice, playback, recommend, general, memory, mcp }
}

function hasStorage(): boolean {
  return typeof uni !== 'undefined' && typeof uni.getStorageSync === 'function'
}

export function loadConfig(): AppConfig {
  try {
    if (!hasStorage()) return createDefaultConfig()
    const raw = uni.getStorageSync(CONFIG_STORAGE_KEY)
    if (!raw) return createDefaultConfig()
    return normalizeConfig(typeof raw === 'string' ? JSON.parse(raw) : raw)
  } catch {
    return createDefaultConfig()
  }
}

export function saveConfig(config: AppConfig): void {
  try {
    if (!hasStorage()) return
    uni.setStorageSync(CONFIG_STORAGE_KEY, JSON.stringify(config))
  } catch {
    // 本地存储不可用时保留内存配置，不阻断会话
  }
}
