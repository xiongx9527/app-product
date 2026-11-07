import { reactive } from 'vue'
import {
  DEFAULT_GATEWAY_WS_URL,
  DEFAULT_GEOCODE,
  DEFAULT_LANGUAGE,
  DEFAULT_TIMEZONE,
  GEOCODE_PROVIDERS,
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  languageLabel,
  normalizeGatewayWsUrl,
  normalizeGeocodeProvider,
  normalizeTimezone,
} from './constants'
import { PROVIDERS, findProvider } from './providers'
import {
  coerceFieldValue,
  createDefaultCapability,
  loadConfig,
  saveConfig,
} from './storage'
import type {
  AppConfig,
  Capability,
  ConfigValue,
  GeocodeConfig,
  GeocodeProvider,
  ProviderField,
  ProviderTemplate,
  ServiceMode,
} from './types'

export {
  DEFAULT_GATEWAY_WS_URL,
  DEFAULT_GEOCODE,
  DEFAULT_LANGUAGE,
  DEFAULT_TIMEZONE,
  GEOCODE_PROVIDERS,
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  languageLabel,
  normalizeGatewayWsUrl,
  normalizeGeocodeProvider,
  normalizeTimezone,
} from './constants'
export {
  CONFIG_STORAGE_KEY,
  createDefaultCapability,
  createDefaultConfig,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from './storage'
export { PROVIDERS, findProvider } from './providers'
export type * from './types'

/** 兼容旧引用：全局默认语言 */
export const APP_LANGUAGE = DEFAULT_LANGUAGE

export const CAPABILITIES: Array<{
  key: Capability
  title: string
  subtitle: string
}> = [
  { key: 'asr', title: '语音识别 ASR', subtitle: '把麦克风音频转成文字' },
  { key: 'llm', title: '大模型 LLM', subtitle: '生成回复；复杂任务可走 AgentScope 网关' },
  { key: 'tts', title: '语音合成 TTS', subtitle: '把回复文字转成语音' },
]

/** 全局响应式配置，页面直接改，保存时整体落本地存储 */
export const appConfig = reactive<AppConfig>(loadConfig())

export function providerOptions(capability: Capability): Array<{
  id: string
  label: string
  template: ProviderTemplate
}> {
  return PROVIDERS[capability].map((template) => ({
    id: template.id,
    label: template.vendor,
    template,
  }))
}

export function getProvider(capability: Capability): ProviderTemplate {
  return (
    findProvider(capability, appConfig[capability].provider) ??
    PROVIDERS[capability][0]
  )
}

/** 取当前（或指定）厂商的参数；缺失时用模板默认值补齐 */
export function getProviderValues(
  capability: Capability,
  providerId: string = appConfig[capability].provider
): Record<string, ConfigValue> {
  const container = appConfig[capability]
  if (!container.byProvider[providerId]) {
    const template = findProvider(capability, providerId)
    container.byProvider[providerId] = template ? { ...template.defaults } : {}
  }
  return container.byProvider[providerId]
}

export function setProvider(capability: Capability, providerId: string): void {
  if (!findProvider(capability, providerId)) return
  appConfig[capability].provider = providerId
  getProviderValues(capability, providerId)
}

export function setFieldValue(
  capability: Capability,
  field: ProviderField,
  raw: unknown
): void {
  const values = getProviderValues(capability)
  const fallback =
    values[field.key] ?? getProvider(capability).defaults[field.key] ?? ''
  values[field.key] = coerceFieldValue(field, raw, fallback)
}

export function resetCapability(capability: Capability): void {
  const fresh = createDefaultCapability(capability)
  appConfig[capability].provider = fresh.provider
  appConfig[capability].byProvider = fresh.byProvider
}

export function resetAll(): void {
  appConfig.mode = 'byok'
  appConfig.language = DEFAULT_LANGUAGE
  for (const capability of Object.keys(PROVIDERS) as Capability[]) {
    resetCapability(capability)
  }
}

export function persistConfig(): void {
  saveConfig(appConfig)
}

export function getLanguage(): string {
  return appConfig.language
}

export function setMode(mode: ServiceMode): void {
  appConfig.mode = mode
}

export function isPlatformMode(): boolean {
  return appConfig.mode === 'platform'
}
