import type { FloatPositionKey } from '../adaptation/floatLayer'
import type { DuckLevel } from './constants'

/**
 * 运行模式：
 * - byok：自带服务，用户填语音服务地址、Key（当前唯一可用）
 * - platform：平台托管，登录后付费用户直接使用平台 ASR / LLM / TTS，不需要任何配置
 */
export type ServiceMode = 'byok' | 'platform'

/** 语音服务来源：仅内置（本地 / 局域网 AI 服务，如 9529）。百炼来源已下线。 */
export type VoiceProviderKind = 'builtin'

/** 语音服务配置（地址 + 密钥 + 可选模型） */
export interface VoiceProviderSettings {
  /** 服务根地址；默认公网语音服务地址 */
  url: string
  /** 服务密钥（内置服务通常为空） */
  apiKey: string
  /**
   * 该来源的 LLM 模型名；留空则由网关用来源默认模型。
   * 下拉选项由设置页「LLM 模型」从来源配置实时拉取。
   */
  model?: string
  /**
   * 该来源的 TTS 音色（voice）；留空则由网关用来源默认音色。
   * 下拉选项由设置页「音色」从内置语音服务接口实时拉取。
   */
  voice?: string
  /**
   * 当前选中音色的「所属模型」（如 cosyvoice-v3-flash / edge-tts）。
   * 与 voice 配套下发，网关据它决定实际请求的 TTS 模型——模型不再写死在网关，
   * 从根本上避免「v1 音色名 + v2 模型」这类 418 InvalidParameter。
   */
  voiceModel?: string
  /**
   * 该来源的 ASR 模型名（如 paraformer-realtime-v2 / fun-asr-realtime / sensevoice-small）。
   * 留空则由网关用来源默认模型；随 session.start.voice 独立下发，网关注入 asr.params.model。
   */
  asrModel?: string
  /**
   * 该来源的 TTS 模型名（如 cosyvoice-v3-flash / qwen-tts / edge-tts）。
   * 留空则沿用音色所属模型（voiceModel）或来源默认；显式填写时优先于 voiceModel。
   */
  ttsModel?: string
  /**
   * 是否开启 LLM 深度思考（推理链）。随 session.start.voice.params.think 下发，
   * 网关透传到 LLM 请求体，由语音服务（9529）按厂商翻译成原生思考参数
   * （deepseek→thinking.type / ollama→think / dashscope→enable_thinking …）。
   * 推理模型才有效；非推理模型忽略。缺省 false（不思考）。
   */
  think?: boolean
}

/**
 * 语音服务配置同时覆盖 ASR / LLM / TTS，统一走内置来源（9529）。
 * provider 字段保留（恒为 'builtin'）随 session.start 下发给网关。
 * 选中的 LLM 模型随会话下发，网关据此路由到来源对应的上游。
 */
export interface VoiceServiceConfig {
  provider: VoiceProviderKind
  builtin: VoiceProviderSettings
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
  /** 好价设置：好价商品每次推荐的条数，独立于语音服务 */
  recommend: RecommendConfig
  /** 时间预算：随 session.start.timeouts 下发网关，控制识别/回复/播报的超时 */
  timeouts: TimeoutsConfig
  /** 通用设置：与具体能力无关、偏行为开关的项统一放这里 */
  general: GeneralConfig
  /** 记忆设置：长期记忆（自动抽取 / 手动指令）相关开关 */
  memory: MemoryConfig
  /**
   * MCP 配置：app 固定对接 model-proxy 的 /mcp（由 webSocketTransport 按服务地址动态生成
   * server，不暴露手动列表）；这里的 enabled 是设置页的总开关，关闭则不下发任何 server。
   */
  mcp: McpConfig
  /**
   * Skill 配置：动态加载 19529 上的 skill（GET /skills 清单 + GET /skills/{name} 正文），
   * 网关按此把 skill 正文注入 systemPrompt。enabled 总开关、retryCount 加载失败重试次数；
   * skill 列表本身从服务端实时拉取，不存本地。
   */
  skill: SkillConfig
}

/** Skill 动态加载配置（设置页「Skill 设置」：开关 + 重试次数，列表实时拉取） */
export interface SkillConfig {
  /** 总开关（默认开）：关闭则不向网关下发 skill 加载配置，助手不加载 19529 的 skill。 */
  enabled: boolean
  /** 拉取 skill 清单/正文失败的重试次数（0=不重试，默认 2），公网偶发抖动自愈。 */
  retryCount: number
}

/** 推荐设置：好价商品每次推荐的条数，独立于语音服务 */
export interface RecommendConfig {
  /**
   * 好价商品推荐条数：每次「推荐好价商品」展示几条，默认 3，范围 1–10。
   * 经 session.start.recommend 下发网关，作为好价工具未显式指定条数时的默认。
   */
  dealsCount: number
}

/**
 * 时间预算（设置页「超时设置」）：随 session.start.timeouts 下发网关。
 * 网关按同一份范围再收敛一次，所以这里填错也只会被夹到边界，不会搞死链路。
 */
export interface TimeoutsConfig {
  /** 定稿识别超时（ms）：说完话等识别结果的最长时间，超时播「没听清」 */
  asrFinalizeMs: number
  /** 中间识别间隔（ms）：界面实时字幕的刷新频率 */
  asrPartialIntervalMs: number
  /** 单轮回复超时（ms）：大模型多久没给完就播兜底话术 */
  llmMs: number
  /** 单次播报合成超时（ms）：单句语音合成的上限 */
  ttsMs: number
  /** 播报卡顿断开（ms）：上游多久不产帧就断开本句 */
  ttsFrameGapMs: number
}

/** 通用设置 */
export interface GeneralConfig {
  /**
   * 自动连接网关：开屏/进入主页即自动连接网关并进入待唤醒，免手动点圆球开启。
   * 默认关闭——避免一启动就建连/常驻监听，用户按需打开。
   */
  autoConnect: boolean
  /**
   * 主题：驱动整体配色（强调色 + 背景辉光），通过页面根元素的 CSS 变量即时生效。
   * 全为深色主题；老配置里的 'auto' 会在归一化时回退到 default。
   */
  theme: 'default' | 'purple' | 'teal' | 'amber'
  /**
   * 语音设置页「定时检查」：开启后设置页每隔一段时间自动重跑能力检测并刷新结果，
   * 免去每次手动点「一键检测」。默认关闭——避免不必要的定时探测开销。
   */
  autoCheck?: boolean
  /** 定时检查间隔（毫秒），只取 AUTO_CHECK_INTERVAL_OPTIONS 里的合法档位；缺省 30s。 */
  autoCheckMs?: number
  /**
   * duck 强度档位（三种 duck 共用）：light/medium/heavy，缺省 medium。
   * 播报 duck 播放（TTS 说话时压背景媒体）不受开关控制、只受此强度控制；
   * 中断前 duck（检测人声开口给 KWS 让路）也按此强度压。
   */
  duckLevel?: DuckLevel
  /** 中断前 duck 开关：播报中检测到人声开口是否压低播报/媒体给 KWS 让路。缺省开。
   *  关掉后播报音量恒定，但"播报 duck 播放"（duckMusic）仍按 duckLevel 生效。 */
  interruptDuck?: boolean
  /** 插话开关：默认关（播报期上行静音、只靠 KWS 打断）。开则恢复播报期上行+插话入队。
   *  duck 机制保留是为插话铺垫——插话开时 duck 让 KWS/ASR 听清开口。 */
  bargeIn?: boolean
  /** 硬件 AEC 开关（对照实验用）：默认关。开=采集全程开系统 AEC（含播报期），
   *  关=全程关。用于测 AEC 开/关对播报中唤醒率的影响。 */
  aecEnabled?: boolean
}

/** 记忆设置 */
export interface MemoryConfig {
  /**
   * 自动记忆（自动抽取）：开启后网关在对话中自动抽取可记忆的信息并沉淀为长期记忆。
   * 手动指令（记录下 / 帮我记 / 记住 等）无论本开关是否开启都始终生效。
   * 默认关闭——避免未经用户确认就把对话内容写入长期记忆。
   */
  autoMemory: boolean
  /**
   * 自动记忆合并（摘要）触发阈值：记忆条数达到此值后才周期性合并去重，避免无限膨胀。
   * 0 表示每轮都合并。经 session.start.memory.consolidateThreshold 下发网关，缺省 30。
   */
  consolidateThreshold: number
  /**
   * 自动记忆合并（摘要）频率：每这么多次抽取触发一次合并。经 session.start.memory.consolidateEvery 下发网关，缺省 5。
   */
  consolidateEvery: number
}

/** 音乐播放源；百度已实现，网易云/腾讯音乐/酷狗音乐为占位空实现（选择后调用会报未实现），后续可扩展 */
export type PlaybackSource = 'baidu' | 'netease' | 'tencent' | 'kugou'

/** MCP 服务器传输方式：stdio（网关侧拉起本地子进程）/ sse（Server-Sent Events）/ http（Streamable HTTP）。 */
export type McpTransport = 'stdio' | 'sse' | 'http'

/** 单个 MCP 服务器配置：由用户在设置页填写并开启，经 session.start 下发给网关连接。 */
export interface McpServerConfig {
  /** 本地稳定标识：新增时生成，用于列表项的 key 与持久化；缺省时由 normalize 补。 */
  id: string
  /** 服务器显示名 */
  name: string
  /** 是否启用（仅启用项随 session.start 下发） */
  enabled: boolean
  /** 传输方式 */
  transport: McpTransport
  /** stdio：要执行的命令（如 npx @modelcontextprotocol/server-filesystem） */
  command?: string
  /** stdio：命令参数 */
  args?: string[]
  /** stdio：子进程环境变量 */
  env?: Record<string, string>
  /** sse / http：服务器地址 */
  url?: string
  /**
   * sse / http：连接时附带的自定义请求头（鉴权用）。
   * 覆盖 Bearer / API Key / 自定义头等各种认证方式（如 Authorization: Bearer xxx、x-api-key: yyy）。
   * stdio 不使用。密钥只落本机，不下发明文到任何第三方。
   */
  headers?: Record<string, string>
  /** 仅启用的工具白名单；不填表示全部启用 */
  enabledTools?: string[]
  /** 禁用的工具黑名单 */
  disabledTools?: string[]
}

/** MCP 服务器列表配置 */
export interface McpConfig {
  /** 总开关（设置页「MCP设置」）：关闭时不把任何 MCP server 下发给网关，整体停用 MCP。 */
  enabled: boolean
  /**
   * 固定对接（服务地址 + /mcp）的传输协议，设置页可选：
   * - http：Streamable HTTP（默认，单端点 POST，无长连接，公网/移动网络更稳）
   * - sse：Server-Sent Events（长连接，部分网络环境下握手收不到 endpoint 事件会超时）
   */
  transport: 'sse' | 'http'
  /** MCP 连接失败重试次数（0=不重试）：公网偶发 fetch failed 时自动重连，默认 2。下次会话生效。 */
  retryCount: number
  servers: McpServerConfig[]
}

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
  /**
   * partial 兜底定稿的字数上限：识别到这么多字就强制定稿，防嘈杂环境无限接收。
   * 随 session.start.playback 下发网关，缺省 30，合法 10–200。
   */
  finalizeMaxChars?: number
  /**
   * partial 兜底定稿的有字超时（ms）：出了字后这么久仍无 final 就强制定稿，
   * 解决 iOS/嘈杂环境 VAD 静音端点不触发导致卡"正在听"。缺省 10000，合法 2000–60000。
   */
  finalizeTimeoutMs?: number
  /**
   * 并行 TTS 合成数上限：遇标点即断句并发合成，最多同时合成几段。缺省 4，合法 1–10。
   */
  ttsConcurrency?: number
  /**
   * 自动退下：用户静默多久后播「还在吗？」（T1）。缺省 30000ms（30秒），合法 5000–300000。
   */
  autoExitMs?: number
  /**
   * 自动退下：播「还在吗？」后等待回应的宽限（T2），超时播「退下了」并退出。
   * 缺省 15000ms（15秒），合法 3000–120000。
   */
  autoExitGraceMs?: number
}
