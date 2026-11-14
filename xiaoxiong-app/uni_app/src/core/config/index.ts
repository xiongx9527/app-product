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
 * voice 与它的所属模型（voiceModel）一起经 params 下发，网关据 params.model 决定真正请求的
 * TTS 模型——模型不再写死，从根本上避免「v1 音色名 + v2 模型」这类 418（见 ttsVoices.ts）。
 */
export function activeVoiceConfig(): {
  provider: VoiceProviderKind
  url: string
  apiKey: string
  model: string
  asrModel: string
  ttsModel: string
  voice: string
  params?: { voice: string; model?: string }
} {
  const v = appConfig.voice
  const active = v.provider === 'dashscope' ? v.dashscope : v.builtin
  // 旧存档里 voice 有值但没记 voiceModel（新加字段）：那个音色来自旧版目录（v1/v2 音色名，
  // 如 longxiang），与当前 cosyvoice-v3 模型不兼容，下发会被云端判 418 Invalid voice、整句静音。
  // 这种脏配置不下发音色，让网关用来源默认音色；设置页重新拉目录时会自动补上合法音色与所属模型。
  const staleDashscopeVoice =
    v.provider === 'dashscope' && !!active.voice && !active.voiceModel
  const voice = staleDashscopeVoice ? '' : (active.voice ?? '')
  // 所属模型只随 DashScope 的 params 下发：只有百炼 TTS 用它决定 CosyVoice 版本，
  // 内置（edge-tts）模型固定、且不希望把它错当成 ASR 的推理 model 字段。
  const voiceModel = v.provider === 'dashscope' ? active.voiceModel || undefined : undefined
  return {
    provider: v.provider,
    url: active.url,
    apiKey: active.apiKey,
    model: active.model ?? '',
    // ASR / TTS 模型走独立顶层字段下发：共用 params 通道会被网关按能力剥离（TTS 专用字段不进 ASR），
    // 塞进去 ASR 根本拿不到。留空即空，由网关沿用来源默认模型。
    asrModel: active.asrModel ?? '',
    ttsModel: active.ttsModel ?? '',
    voice,
    params: voice ? { voice, model: voiceModel } : undefined,
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
