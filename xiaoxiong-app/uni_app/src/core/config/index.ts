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
  createDefaultPlayback,
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
  createDefaultPlayback,
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
 * 切换语音服务来源（内置 / DashScope）。只改 provider，两套来源的地址、密钥各自保留，
 * 不会互相清掉——切回内置时它之前填过的地址还在，切到 DashScope 也是。
 */
export function setVoiceProvider(provider: VoiceProviderKind): void {
  appConfig.voice.provider = provider
}

/**
 * 取当前来源这一份配置，压平成网关识别的扁平结构（provider / url / apiKey / model / voice）。
 * 各来源独立保存，这里只取「当前选中的那一份」；model / voice 缺省时留空，由网关用来源默认值。
 * voice 经 params.voice 下发，网关据此透传给 TTS（见 gateway voiceConfig.resolveCapabilityConfig）。
 */
export function activeVoiceConfig(): {
  provider: VoiceProviderKind
  url: string
  apiKey: string
  model: string
  voice: string
  params?: { voice: string }
} {
  const v = appConfig.voice
  const active = v.provider === 'dashscope' ? v.dashscope : v.builtin
  const voice = active.voice ?? ''
  return {
    provider: v.provider,
    url: active.url,
    apiKey: active.apiKey,
    model: active.model ?? '',
    voice,
    params: voice ? { voice } : undefined,
  }
}

/** 语音服务恢复默认（内置 / 本地 9529 / 无密钥） */
export function resetVoice(): void {
  appConfig.voice = createDefaultVoice()
}

/** 播放设置恢复默认（百度源 / 关闭自动收藏 / 开启自动字幕 / 关闭自动循环 / 默认循环 3 次 / 默认音量 50%） */
export function resetPlayback(): void {
  appConfig.playback = createDefaultPlayback()
}
