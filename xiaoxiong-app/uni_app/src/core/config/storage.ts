import {
  DEFAULT_LANGUAGE,
  DEFAULT_TIMEZONE,
  normalizeTimezone,
  SUBTITLE_FONT_SIZE_OPTIONS,
  SUBTITLE_COLOR_OPTIONS,
  DEFAULT_SUBTITLE_FONT_SIZE,
  DEFAULT_SUBTITLE_COLOR,
} from './constants'
import { FLOAT_POSITION_PRESETS, type FloatPositionKey } from '../adaptation/floatLayer'
import type { AppConfig, GeneralConfig, MemoryConfig, McpConfig, McpServerConfig, McpTransport, PlaybackConfig, PlaybackSource, RecommendConfig, ServiceMode, VoiceProviderKind, VoiceProviderSettings, VoiceServiceConfig } from './types'

export const CONFIG_STORAGE_KEY = 'app-product.config.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DEFAULT_VOICE: VoiceServiceConfig = {
  provider: 'builtin',
  builtin: { url: 'http://127.0.0.1:9529', apiKey: '', model: '', voice: '', voiceModel: '' },
  dashscope: { url: '', apiKey: '', model: '', voice: '', voiceModel: '' },
}

/** 默认语音服务：内置、本地 9529、无需密钥 */
export function createDefaultVoice(): VoiceServiceConfig {
  return {
    provider: DEFAULT_VOICE.provider,
    builtin: { ...DEFAULT_VOICE.builtin },
    dashscope: { ...DEFAULT_VOICE.dashscope },
  }
}

const DEFAULT_PLAYBACK: PlaybackConfig = {
  source: 'baidu',
  autoSave: false,
  autoSubtitle: true,
  defaultLoop: 3,
  autoLoop: false,
  defaultVolume: 0.5,
  floatPlayer: true,
  floatPosition: 'top-center',
  subtitleFontSize: DEFAULT_SUBTITLE_FONT_SIZE,
  subtitleColor: DEFAULT_SUBTITLE_COLOR,
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
  }
}

const DEFAULT_RECOMMEND: RecommendConfig = {
  dealsCount: 3,
  opensourceCount: 3,
}

/** 默认推荐设置：好价商品 / 开源工具均推荐 3 条，范围 1–10。 */
export function createDefaultRecommend(): RecommendConfig {
  return { dealsCount: DEFAULT_RECOMMEND.dealsCount, opensourceCount: DEFAULT_RECOMMEND.opensourceCount }
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

/** 通用设置默认值：自动连接网关默认开启（开屏即连网关进入待唤醒，免去手动点开关）。 */
function createDefaultGeneral(): GeneralConfig {
  return { autoConnect: true }
}

/** 归一化通用设置：autoConnect 只认 boolean，缺省/非法回退默认（开）。 */
function normalizeGeneral(raw: unknown): GeneralConfig {
  const source = isRecord(raw) ? raw : {}
  const autoConnect =
    typeof source.autoConnect === 'boolean' ? source.autoConnect : createDefaultGeneral().autoConnect
  return { autoConnect }
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

/** MCP 服务器列表默认值：空列表（不连接任何 MCP 服务器）。 */
function createDefaultMcp(): McpConfig {
  return { servers: [] }
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
  return { id, name, enabled, transport, url, enabledTools, disabledTools }
}

/** 归一化 MCP 配置：servers 逐项校验，非法项丢弃；非数组/缺省回退空列表。 */
function normalizeMcp(raw: unknown): McpConfig {
  const source = isRecord(raw) ? raw : {}
  const list = Array.isArray(source.servers) ? source.servers : []
  const servers = list.map(normalizeMcpServer).filter((s): s is McpServerConfig => s !== null)
  return { servers }
}

function normalizeProviderSettings(
  raw: unknown,
  fallback: { url: string; apiKey: string; model?: string; voice?: string; voiceModel?: string }
): VoiceProviderSettings {
  const source = isRecord(raw) ? raw : {}
  const url = typeof source.url === 'string' ? source.url.trim() : ''
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey : ''
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  const voice = typeof source.voice === 'string' ? source.voice.trim() : ''
  const voiceModel = typeof source.voiceModel === 'string' ? source.voiceModel.trim() : ''
  return {
    url: url || fallback.url,
    apiKey: apiKey || fallback.apiKey,
    model: model || fallback.model || '',
    voice: voice || fallback.voice || '',
    voiceModel: voiceModel || fallback.voiceModel || '',
  }
}

/**
 * 归一化语音服务配置：provider 只接受 builtin / dashscope，其余落回 builtin；
 * 两个来源各自独立保存地址与密钥。兼容旧的单份 url/apiKey 存档（迁移进当时选中的来源）。
 */
function normalizeVoice(raw: unknown): VoiceServiceConfig {
  const source = isRecord(raw) ? raw : {}
  const provider: VoiceProviderKind =
    source.provider === 'dashscope' || source.provider === 'builtin'
      ? (source.provider as VoiceProviderKind)
      : 'builtin'
  // 旧格式：直接挂在 voice 上的 url / apiKey，迁移到当前 provider 这一份
  const legacyUrl = typeof source.url === 'string' ? source.url.trim() : ''
  const legacyApiKey = typeof source.apiKey === 'string' ? source.apiKey : ''
  const builtin = normalizeProviderSettings(
    source.builtin,
    provider === 'builtin'
      ? { url: legacyUrl || DEFAULT_VOICE.builtin.url, apiKey: legacyApiKey || DEFAULT_VOICE.builtin.apiKey }
      : { url: DEFAULT_VOICE.builtin.url, apiKey: DEFAULT_VOICE.builtin.apiKey }
  )
  const dashscope = normalizeProviderSettings(
    source.dashscope,
    provider === 'dashscope'
      ? { url: legacyUrl || DEFAULT_VOICE.dashscope.url, apiKey: legacyApiKey || DEFAULT_VOICE.dashscope.apiKey }
      : { url: DEFAULT_VOICE.dashscope.url, apiKey: DEFAULT_VOICE.dashscope.apiKey }
  )
  return { provider, builtin, dashscope }
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
  // 悬浮小圆播放器：boolean，缺省开启（纯客户端 UI 开关，不下发网关）。
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
  }
}

/**
 * 归一化推荐设置：dealsCount / opensourceCount 只接受 1–10 的整数，缺省/非法回退 3。
 * 与网关工具上限一致（好价/开源工具收敛到 1–10），避免下发网关不认识的条数。
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
    opensourceCount: toCount(source.opensourceCount, DEFAULT_RECOMMEND.opensourceCount),
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
