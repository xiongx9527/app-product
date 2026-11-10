/**
 * 运行模式：
 * - byok：自带服务，用户自己选语音服务来源（内置 / DashScope）并填地址、Key（当前唯一可用）
 * - platform：平台托管，登录后付费用户直接使用平台 ASR / LLM / TTS，不需要任何配置
 */
export type ServiceMode = 'byok' | 'platform'

/** 语音服务来源：内置（本地 / 局域网 AI 服务）或 DashScope 云端 */
export type VoiceProviderKind = 'builtin' | 'dashscope'

/** 单个来源的语音服务配置（地址 + 密钥 + 可选 LLM 模型），内置 / DashScope 各存一份，互不影响 */
export interface VoiceProviderSettings {
  /** 服务根地址；内置默认 http://127.0.0.1:9529，DashScope 默认 https://dashscope.aliyuncs.com */
  url: string
  /** 内置通常为空；DashScope 必填 */
  apiKey: string
  /**
   * 该来源的 LLM 模型名；留空则由网关用来源默认模型。
   * 下拉选项由设置页「LLM 模型」从来源配置实时拉取。
   */
  model?: string
  /**
   * 该来源的 TTS 音色（voice）；留空则由网关用来源默认音色。
   * 下拉选项由设置页「音色」从来源配置实时拉取（内置=语音服务接口；百炼=官方标准目录）。
   */
  voice?: string
}

/**
 * 语音服务配置同时覆盖 ASR / LLM / TTS，按 provider 切换。
 * 各来源独立保存自己的地址、密钥与模型，切换来源只改 provider，不会清掉另一份数据。
 * 选中的 LLM 模型随会话下发，网关据此路由到来源对应的上游。
 */
export interface VoiceServiceConfig {
  provider: VoiceProviderKind
  builtin: VoiceProviderSettings
  dashscope: VoiceProviderSettings
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
  /** 播放设置（音乐播放源等），独立于语音服务 */
  playback: PlaybackConfig
}

/** 音乐播放源；百度已实现，网易云/腾讯音乐/酷狗音乐为占位空实现（选择后调用会报未实现），后续可扩展 */
export type PlaybackSource = 'baidu' | 'netease' | 'tencent' | 'kugou'

/** 播放设置：音乐播放来源等，独立于语音服务（ASR / LLM / TTS） */
export interface PlaybackConfig {
  /** 当前播放源，默认百度 */
  source: PlaybackSource
  /** 播放音乐时是否自动拉取并展示字幕（同源），默认开启 */
  autoSubtitle?: boolean
  /**
   * 播放完是否自动收藏：歌曲自然播放结束（含循环播完）后自动加入「我的收藏」。
   * 默认关闭；收藏的读写后端（网关 SQLite + REST）尚未实现，当前仅客户端内存列表演示。
   */
  autoSave: boolean
  /**
   * 默认循环播放次数（含当前这一遍）；0 表示不循环。默认 3。
   * 与界面「循环」按钮的临时档位独立：此处是每次新播放的默认值，由网关下发 media.play 时带入。
   */
  defaultLoop: number
  /**
   * 默认音量（0–1，与 media.volume / 播放器音量同域）；默认 0.5（即 50%）。
   * 由网关开始播放时带入；后续实现后端时按此默认值下发 media.volume。
   */
  defaultVolume: number
}
