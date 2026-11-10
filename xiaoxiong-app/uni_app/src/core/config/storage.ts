import { DEFAULT_LANGUAGE, DEFAULT_TIMEZONE, normalizeTimezone } from './constants'
import type { AppConfig, ServiceMode, VoiceProviderKind, VoiceServiceConfig } from './types'

export const CONFIG_STORAGE_KEY = 'app-product.config.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const DEFAULT_VOICE: VoiceServiceConfig = {
  provider: 'builtin',
  url: 'http://127.0.0.1:9529',
  apiKey: '',
}

/** 默认语音服务：内置、本地 9529、无需密钥 */
export function createDefaultVoice(): VoiceServiceConfig {
  return { ...DEFAULT_VOICE }
}

export function createDefaultConfig(): AppConfig {
  return {
    version: 1,
    mode: 'byok',
    language: DEFAULT_LANGUAGE,
    timezone: DEFAULT_TIMEZONE,
    voice: createDefaultVoice(),
  }
}

/**
 * 归一化一份语音服务配置：provider 只接受 builtin / dashscope，其余落回 builtin；
 * url / apiKey 收敛成字符串并去空格。内置缺地址时补默认根地址，避免空串连到奇怪的地方。
 */
function normalizeVoice(raw: unknown): VoiceServiceConfig {
  const source = isRecord(raw) ? raw : {}
  const provider: VoiceProviderKind =
    source.provider === 'dashscope' || source.provider === 'builtin'
      ? (source.provider as VoiceProviderKind)
      : 'builtin'
  const url = typeof source.url === 'string' ? source.url.trim() : ''
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey : ''
  return {
    provider,
    url:
      provider === 'builtin' && !url
        ? DEFAULT_VOICE.url
        : url,
    apiKey,
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

  return { version: 1, mode, language, timezone, voice }
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
