import { reactive } from 'vue'
import {
  DEFAULT_GATEWAY_WS_URL,
  DEFAULT_LANGUAGE,
  DEFAULT_TIMEZONE,
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  languageLabel,
  normalizeTimezone,
} from './constants'
import {
  createDefaultConfig,
  createDefaultVoice,
  loadConfig,
  saveConfig,
} from './storage'
import type { AppConfig, ServiceMode, VoiceProviderKind } from './types'

export {
  DEFAULT_GATEWAY_WS_URL,
  DEFAULT_LANGUAGE,
  DEFAULT_TIMEZONE,
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  languageLabel,
  normalizeTimezone,
} from './constants'
export {
  CONFIG_STORAGE_KEY,
  createDefaultConfig,
  createDefaultVoice,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from './storage'
export type * from './types'

/** 兼容旧引用：全局默认语言 */
export const APP_LANGUAGE = DEFAULT_LANGUAGE

/** 全局响应式配置，页面直接改，保存时整体落本地存储 */
export const appConfig = reactive<AppConfig>(loadConfig())

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

/**
 * 切换语音服务来源（内置 / DashScope）。切换时清空地址，让各自套用默认根地址
 * （内置 9529 / DashScope 云端），避免把上一个来源的地址带过来展示；已填的 Key 保留。
 */
export function setVoiceProvider(provider: VoiceProviderKind): void {
  if (appConfig.voice.provider === provider) return
  appConfig.voice.provider = provider
  appConfig.voice.url = ''
}

/** 语音服务恢复默认（内置 / 本地 9529 / 无密钥） */
export function resetVoice(): void {
  appConfig.voice = createDefaultVoice()
}
