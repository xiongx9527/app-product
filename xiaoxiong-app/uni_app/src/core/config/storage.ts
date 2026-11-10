import { DEFAULT_LANGUAGE, DEFAULT_TIMEZONE, normalizeTimezone } from './constants'
import type { AppConfig, PlaybackConfig, PlaybackSource, ServiceMode, VoiceProviderKind, VoiceProviderSettings, VoiceServiceConfig } from './types'

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

const DEFAULT_PLAYBACK: PlaybackConfig = { source: 'baidu' }

/** 默认播放设置：播放源百度 */
export function createDefaultPlayback(): PlaybackConfig {
  return { source: DEFAULT_PLAYBACK.source }
}

export function createDefaultConfig(): AppConfig {
  return {
    version: 1,
    mode: 'byok',
    language: DEFAULT_LANGUAGE,
    timezone: DEFAULT_TIMEZONE,
    voice: createDefaultVoice(),
    playback: createDefaultPlayback(),
  }
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
  const valid: PlaybackSource[] = ['baidu']
  return { source: valid.includes(src as PlaybackSource) ? (src as PlaybackSource) : 'baidu' }
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

  return { version: 1, mode, language, timezone, voice, playback }
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
