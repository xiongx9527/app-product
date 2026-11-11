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
import type { AppConfig, GeneralConfig, PlaybackConfig, PlaybackSource, ServiceMode, VoiceProviderKind, VoiceProviderSettings, VoiceServiceConfig } from './types'

export const CONFIG_STORAGE_KEY = 'app-product.config.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DEFAULT_VOICE: VoiceServiceConfig = {
  provider: 'builtin',
  builtin: { url: 'http://127.0.0.1:9529', apiKey: '', model: '' },
  dashscope: { url: '', apiKey: '', model: '' },
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

export function createDefaultConfig(): AppConfig {
  return {
    version: 1,
    mode: 'byok',
    language: DEFAULT_LANGUAGE,
    timezone: DEFAULT_TIMEZONE,
    voice: createDefaultVoice(),
    playback: createDefaultPlayback(),
    general: createDefaultGeneral(),
  }
}

/** 通用设置默认值：自动连接网关默认开启（开屏即连网关进入待唤醒，免去手动点开关）。 */
function createDefaultGeneral(): GeneralConfig {
  return { autoConnect: true }
}

/** 归一化通用设置：autoWake 只认 boolean，缺省/非法回退 false。 */
function normalizeGeneral(raw: unknown): GeneralConfig {
  const source = isRecord(raw) ? raw : {}
  const autoWake = typeof source.autoWake === 'boolean' ? source.autoWake : false
  return { autoWake }
}

function normalizeProviderSettings(
  raw: unknown,
  fallback: { url: string; apiKey: string; model?: string; voice?: string }
): VoiceProviderSettings {
  const source = isRecord(raw) ? raw : {}
  const url = typeof source.url === 'string' ? source.url.trim() : ''
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey : ''
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  const voice = typeof source.voice === 'string' ? source.voice.trim() : ''
  return {
    url: url || fallback.url,
    apiKey: apiKey || fallback.apiKey,
    model: model || fallback.model || '',
    voice: voice || fallback.voice || '',
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
  const general = normalizeGeneral(source.general ?? base.general)

  return { version: 1, mode, language, timezone, voice, playback, general }
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
