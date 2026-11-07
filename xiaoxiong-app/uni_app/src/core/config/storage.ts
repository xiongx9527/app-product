import {
  DEFAULT_GEOCODE,
  DEFAULT_LANGUAGE,
  DEFAULT_TIMEZONE,
  normalizeGeocodeProvider,
  normalizeTimezone,
} from './constants'
import { PROVIDERS, findProvider } from './providers'
import type {
  AppConfig,
  Capability,
  CapabilityConfig,
  ConfigValue,
  ProviderField,
  ProviderTemplate,
  ServiceMode,
} from './types'

export const CONFIG_STORAGE_KEY = 'app-product.config.v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createDefaultCapability(capability: Capability): CapabilityConfig {
  const templates = PROVIDERS[capability]
  const byProvider: Record<string, Record<string, ConfigValue>> = {}
  for (const template of templates) {
    byProvider[template.id] = { ...template.defaults }
  }
  return { provider: templates[0].id, byProvider }
}

export function createDefaultConfig(): AppConfig {
  return {
    version: 1,
    mode: 'byok',
    language: DEFAULT_LANGUAGE,
    timezone: DEFAULT_TIMEZONE,
    geocode: { ...DEFAULT_GEOCODE },
    asr: createDefaultCapability('asr'),
    llm: createDefaultCapability('llm'),
    tts: createDefaultCapability('tts'),
  }
}

/**
 * 把界面/存储里来的原始值收敛成字段声明的类型。
 * 数字夹在 min/max 内，单选必须是合法项，避免脏配置把运行时搞崩。
 */
export function coerceFieldValue(
  field: ProviderField,
  raw: unknown,
  fallback: ConfigValue
): ConfigValue {
  switch (field.type) {
    case 'switch':
      if (typeof raw === 'boolean') return raw
      if (raw === 'true') return true
      if (raw === 'false') return false
      return fallback === true

    case 'number': {
      const value =
        typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? '').trim())
      if (!Number.isFinite(value)) return fallback
      const min = field.min ?? Number.NEGATIVE_INFINITY
      const max = field.max ?? Number.POSITIVE_INFINITY
      return Math.min(max, Math.max(min, value))
    }

    case 'select': {
      const value = String(raw ?? '')
      return field.options?.some((option) => option.value === value)
        ? value
        : fallback
    }

    default:
      return String(raw ?? '')
  }
}

function normalizeCapability(
  capability: Capability,
  raw: unknown,
  fallback: CapabilityConfig
): CapabilityConfig {
  const source = isRecord(raw) ? raw : {}
  const savedProviders = isRecord(source.byProvider) ? source.byProvider : {}
  const templates = PROVIDERS[capability]
  const byProvider: Record<string, Record<string, ConfigValue>> = {}

  for (const template of templates) {
    const saved = isRecord(savedProviders[template.id])
      ? (savedProviders[template.id] as Record<string, unknown>)
      : {}
    const values: Record<string, ConfigValue> = {}
    for (const field of template.fields) {
      const defaultValue = template.defaults[field.key] ?? ''
      values[field.key] =
        field.key in saved
          ? coerceFieldValue(field, saved[field.key], defaultValue)
          : defaultValue
    }
    byProvider[template.id] = values
  }

  const provider =
    typeof source.provider === 'string' && findProvider(capability, source.provider)
      ? source.provider
      : fallback.provider

  return { provider, byProvider }
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

  const geocodeSource = isRecord(source.geocode) ? source.geocode : {}
  const geocode = {
    provider: normalizeGeocodeProvider(geocodeSource.provider),
    key: geocodeSource.key != null ? String(geocodeSource.key) : DEFAULT_GEOCODE.key,
  }

  return {
    version: 1,
    mode,
    language,
    timezone,
    geocode,
    asr: normalizeCapability('asr', source.asr, base.asr),
    llm: normalizeCapability('llm', source.llm, base.llm),
    tts: normalizeCapability('tts', source.tts, base.tts),
  }
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

export function providerOf(
  config: AppConfig,
  capability: Capability
): ProviderTemplate {
  return (
    findProvider(capability, config[capability].provider) ?? PROVIDERS[capability][0]
  )
}
