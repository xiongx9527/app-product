import type { FloatPositionKey } from '../adaptation/floatLayer'

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
  /**
   * 当前选中音色的「所属模型」（如 cosyvoice-v3-flash / edge-tts）。
   * 与 voice 配套下发，网关据它决定实际请求的 TTS 模型——模型不再写死在网关，
   * 从根本上避免「v1 音色名 + v2 模型」这类 418 InvalidParameter。
   */
  voiceModel?: string
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
  /** 推荐设置：好价商品 / 开源工具每次推荐的条数，独立于语音服务 */
  recommend: RecommendConfig
  /** 通用设置：与具体能力无关、偏行为开关的项统一放这里 */
  general: GeneralConfig
}

/** 推荐设置：好价商品 / 开源工具每次推荐的条数，独立于语音服务 */
export interface RecommendConfig {
  /**
   * 好价商品推荐条数：每次「推荐好价商品」展示几条，默认 3，范围 1–10。
   * 经 session.start.recommend 下发网关，作为好价工具未显式指定条数时的默认。
   */
  dealsCount: number
  /**
   * 开源工具推荐条数：每次「推荐开源工具」展示几个，默认 3，范围 1–10。
   * 经 session.start.recommend 下发网关，作为开源工具未显式指定条数时的默认。
   */
  opensourceCount: number
}

/** 通用设置 */
export interface GeneralConfig {
  /**
   * 自动连接网关：开屏/进入主页即自动连接网关并进入待唤醒，免手动点圆球开启。
   * 默认关闭——避免一启动就建连/常驻监听，用户按需打开。
   */
  autoConnect: boolean
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
   * 仅在「自动循环播放」开关开启、或用户显式说「循环 N 遍」、或手动开启循环时生效；
   * 普通「放首歌」不自动循环（避免每首歌都重复播）。
   */
  defaultLoop: number
  /**
   * 是否自动循环播放：开启后，每一次新播放（点歌/换一首）默认按 defaultLoop 遍数循环；
   * 关闭则只在用户显式「循环 N 遍」指令或手动循环按钮时才循环，普通播放只播一遍。默认关闭。
   */
  autoLoop?: boolean
  /**
   * 默认音量（0–1，与 media.volume / 播放器音量同域）；默认 0.5（即 50%）。
   * 每次新播放开始时由网关经 media.volume 下发，与「自动循环播放」开关无关。
   */
  defaultVolume: number
  /**
   * 是否显示「悬浮小圆播放器」（酷狗式圆形旋转唱片封面 + 当前歌词大字），默认开启。
   * 纯客户端 UI 开关，不下发网关；关闭时保持现有播放条与字幕面板。
   */
  floatPlayer?: boolean
  /** 悬浮小圆的显示位置（通用悬浮层位置参数 key），默认顶部居中 */
  floatPosition?: FloatPositionKey
  /** 当前字幕（悬浮当前句 / 面板高亮行）字号 px，默认 18，只接受预设档位 [14,18,22,26] */
  subtitleFontSize?: number
  /** 当前字幕颜色（预设 hex），默认白色 */
  subtitleColor?: string
}
