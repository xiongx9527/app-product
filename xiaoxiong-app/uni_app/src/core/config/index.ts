import { reactive } from 'vue'
import {
  DEFAULT_GATEWAY_WS_URL,
  DEFAULT_LANGUAGE,
  DEFAULT_TIMEZONE,
  LANGUAGE_OPTIONS,
  TIMEZONE_OPTIONS,
  normalizeTimezone,
} from './constants'
import {
  createDefaultConfig,
  createDefaultPlayback,
  createDefaultTimeouts,
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
  normalizeTimezone,
} from './constants'
export {
  CONFIG_STORAGE_KEY,
  createDefaultConfig,
  createDefaultPlayback,
  createDefaultTimeouts,
  createDefaultVoice,
  loadConfig,
  normalizeConfig,
  normalizeTimeouts,
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
 * 取当前语音配置，压平成网关识别的扁平结构（provider / url / apiKey / model / voice）。
 * 统一走内置来源；model / voice 缺省时留空，由网关用来源默认值。
 */
export function activeVoiceConfig(): {
  provider: VoiceProviderKind
  url: string
  apiKey: string
  model: string
  asrModel: string
  ttsModel: string
  voice: string
  /** 厂商级通用参数：language 来自通用设置的界面语言（zh-CN→zh / en-US→en），
   *  走 params 下发，网关 asr/http.ts 从 params.language 读取（默认 zh）。
   *  think 为 LLM 深度思考开关，网关透传到 LLM 请求体由语音服务按厂商翻译。 */
  params?: { voice?: string; language?: string; think?: boolean }
} {
  const active = appConfig.voice.builtin
  const voice = active.voice ?? ''
  return {
    provider: appConfig.voice.provider,
    url: active.url,
    apiKey: active.apiKey,
    model: active.model ?? '',
    // ASR / TTS 模型走独立顶层字段下发：共用 params 通道会被网关按能力剥离（TTS 专用字段不进 ASR），
    // 塞进去 ASR 根本拿不到。留空即空，由网关沿用来源默认模型。
    asrModel: active.asrModel ?? '',
    ttsModel: active.ttsModel ?? '',
    voice,
    // 语言走通用参数 params.language 下发：网关 asr/http.ts 从 params.language 读取。
    // 没有音色时也下发 params（只带 language），保证 ASR 始终拿到通用设置里的语言。
    params: {
      ...(voice ? { voice } : {}),
      language: appConfig.language.toLowerCase().split(/[-_]/)[0] || 'zh',
      // 深度思考开关随 params 下发：网关 sharedParams 只剥 TTS 专用字段（voice/model），
      // think 会进 llm.params → presetGenParams → 请求 body → 9529 翻译成厂商原生思考参数。
      // 只有开启时才带该字段，关闭/缺省不带，沿用上游默认行为（避免发出上游不认的字段）。
      ...(active.think ? { think: true } : {}),
    },
  }
}

/** 语音服务恢复默认（内置 / 公网语音服务 / 无密钥） */
export function resetVoice(): void {
  appConfig.voice = createDefaultVoice()
}

/** 播放设置恢复默认（百度源 / 关闭自动收藏 / 开启自动字幕 / 关闭自动循环 / 默认循环 3 次 / 默认音量 50%） */
export function resetPlayback(): void {
  appConfig.playback = createDefaultPlayback()
}

/** 超时设置恢复默认（定稿 12s / 中间识别间隔 600ms / 回复 15s / 合成 25s / 卡顿断开 30s） */
export function resetTimeouts(): void {
  appConfig.timeouts = createDefaultTimeouts()
}
