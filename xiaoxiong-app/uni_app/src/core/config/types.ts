/**
 * 运行模式：
 * - byok：自带服务，用户自己选语音服务来源（内置 / DashScope）并填地址、Key（当前唯一可用）
 * - platform：平台托管，登录后付费用户直接使用平台 ASR / LLM / TTS，不需要任何配置
 */
export type ServiceMode = 'byok' | 'platform'

/** 语音服务来源：内置（本地 / 局域网 AI 服务）或 DashScope 云端 */
export type VoiceProviderKind = 'builtin' | 'dashscope'

/**
 * 一份语音服务配置同时覆盖 ASR / LLM / TTS，切换只改 provider。
 * 模型、音色不在这里填，由网关按 provider 用默认值（见 dashscope-ws-voice.md §5）。
 */
export interface VoiceServiceConfig {
  provider: VoiceProviderKind
  /** 服务根地址；内置默认 http://127.0.0.1:9529，DashScope 默认 https://dashscope.aliyuncs.com */
  url: string
  /** 内置通常为空；DashScope 必填 */
  apiKey: string
}

export interface AppConfig {
  version: 1
  mode: ServiceMode
  /** 全局语言，ASR / TTS / 唤醒识别跟随；默认中文 zh-CN */
  language: string
  /** 全局时区（IANA，如 Asia/Shanghai）；时间类工具按它返回用户所在时区的时间，默认东 8 区 */
  timezone: string
  /** 语音服务（ASR / LLM / TTS 共用一份）：取代旧的三份 asr / llm / tts 子配置 */
  voice: VoiceServiceConfig
}
