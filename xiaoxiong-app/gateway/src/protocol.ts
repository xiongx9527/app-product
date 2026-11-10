/**
 * 网关 ↔ 客户端的 WebSocket 语音协议类型。
 * 与仓库根目录 contracts/README.md 保持一致：文本帧走 JSON 控制消息，
 * 二进制帧走音频（客户端→服务端=麦克风 PCM 16k/16bit/mono，
 * 服务端→客户端=TTS PCM pcm16/24000），方向天然区分上下行。
 */

import type { VoiceConfig } from './voiceConfig'

/** 字幕行：time 为该行起始时间（秒，相对音轨开头），用于客户端跟随播放进度高亮。 */
export interface SubtitleLine {
  time: number
  text: string
}

export type Lang = 'zh-CN'

/** 设备上报的位置：经纬度必填，address 为系统定位回调附带的可读地址（城市/街道），可选。 */
export interface LocationInfo {
  latitude: number
  longitude: number
  address?: string
}

/** 客户端 → 服务端（文本控制帧） */
export type ClientMessage =
  | {
      type: 'session.start'
      sessionId: string
      lang: Lang
      /** 客户端本地 IANA 时区（如 Asia/Shanghai），用于时间类工具按用户时区返回，缺省走服务端本地时区 */
      timezone?: string
      /** 设备当前位置（经纬度 + 可选地址），用于位置类工具返回，缺省由 session.location 补齐 */
      location?: LocationInfo
      /** wake=只做 ASR（用于本地唤醒词检测，不跑 LLM/TTS）；dialog=完整对话，默认 */
      mode?: 'wake' | 'dialog'
      /**
       * 客户端设置页选的语音服务配置（内置 / DashScope + 地址 + Key）。
       * 网关据此展开成 ASR / LLM / TTS 三套能力的真实地址，不再依赖服务端写死的 .env 地址。
       */
      voice?: VoiceConfig
      /**
       * 播放设置（音乐播放源等），来自客户端设置页。网关据此决定点歌走哪个来源；
       * 缺省按百度（B 站音轨 + 百度搜索兜底）。新增播放源时在此扩展 source 取值。
       */
      playback?: { source?: string; autoSubtitle?: boolean }
      /**
       * 设备稳定标识：客户端持久化生成（一次），连接时随 WS URL query 与 payload 上报。
       * 网关据此把会话与连接解耦——同一设备的重连/重唤醒走「重新武装」复用会话，
       * 保留 LLM 对话记忆与待选歌单，不再因断线重连而失忆。缺省（旧客户端未上报）时
       * 每连接独立会话、不复用。
       */
      deviceId?: string
    }
  | { type: 'session.cancel' }
  | { type: 'session.end' }
  /** 客户端定位更新：连接后或位置变化时补报/刷新最新位置 */
  | { type: 'session.location'; latitude: number; longitude: number; address?: string }
  /** 播放设置实时更新：在已建立的会话里改了播放源，立即推给网关重建音乐源，无需重连/重唤醒 */
  | { type: 'session.playback'; source?: string }
  /** 客户端本地播放队列清空后回执：网关据此才消费排队的下一句 */
  | { type: 'session.playback_done' }
  /** 客户端点「换一首 / 换个风格」：网关用当前音乐源解析下一首并下发 media.play */
  | { type: 'music.next'; genre?: string }
  /** 客户端拖动音量滑块后回执当前音量（0–1），网关据此保持音量状态同步，供「调大/调小」相对增减用 */
  | { type: 'music.volume'; volume: number }

/** 服务端 → 客户端（文本控制帧），与契约一致 */
export type ServerEvent =
  | { type: 'asr.partial'; text: string }
  /** queueRemaining=网关队列此刻还剩几句；由服务端给出，客户端据此同步而不靠猜测 */
  | { type: 'asr.final'; text: string; queueRemaining: number }
  /** 当前轮还没播完，这句只识别不回复，按序排队等本轮结束 */
  | { type: 'asr.queued'; text: string; position: number; size: number; message: string }
  /** 这句没有被接收，message 为按 lang 本地化的原因 */
  /** reason 标记「队列满」拒收，客户端据此在固定提示区展示专用话术 */
  | { type: 'asr.rejected'; text: string; message: string; reason: 'queue-full' }
  | { type: 'llm.thinking'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done' }
  | { type: 'tts.start'; format: string; sampleRate: number }
  | { type: 'tts.stop' }
  | { type: 'tts.end' }
  /** half=回声兜底中，播报期间不拾音，用户需点「打断」；full=正常全双工 */
  | { type: 'audio.duplex'; mode: 'half' | 'full' }
  /** 让客户端播放一段音频流（如 SomaFM 网络电台）；客户端用独立播放器，不与 TTS 冲突。
   *  loop 为「总共播放几遍」，缺省/1 表示不循环；客户端播完最后一遍进入「已播完」态。
   *  proxy 标记该直链需经网关 /music/stream 代理：要么带防盗链（如 B 站，需 Referer），
   *  要么拒绝非浏览器 UA（如 SomaFM，原生 App 播放器会被 403）。客户端 InnerAudioContext
   *  无法自定义请求头，统一由网关带浏览器 UA/Referer 代拉。频道/直链→代理的判定由网关持有
   *  （源特有知识），客户端只认此标记，不再写死频道名 / host。 */
  | { type: 'media.play'; url: string; title: string; channel?: string; loop?: number; proxy?: boolean }
  /** 让客户端停止当前播放 */
  | { type: 'media.stop' }
  /** 让客户端暂停当前播放（再响一声「暂停」用 media.resume 恢复） */
  | { type: 'media.pause' }
  /** 让客户端恢复（继续）被暂停的播放 */
  | { type: 'media.resume' }
  /** 让客户端展示某首歌/视频的字幕（同源：来自当前播放源）。
   *  lines 为带每行起始时间的逐行字幕，客户端据此跟随播放进度高亮并支持复制。 */
  | { type: 'media.subtitle'; title: string; artist?: string; lines: SubtitleLine[] }
  /** 让客户端把音乐音量设到指定值（0–1）；语音「音量 30% / 调大 / 调小」时由网关下发 */
  | { type: 'media.volume'; volume: number }
  /** 服务端需要设备位置（位置/天气类工具被调用但会话尚无位置）时才下发，
   * 客户端据此请求定位授权并上报 session.location；不在建连时主动要位置，避免冷启动弹窗。 */
  | { type: 'client.location.request' }
  /** 让客户端播一条「能力不可用」提示音（网关侧 /static/cues/<cue>.mp3）：
   *  ASR/TTS/LLM 未就绪时，网关在本帧前无法用语音播报，改用预录提示音告知用户。
   *  只需传提示音名，客户端按名拉取播放，不下发具体文案（提示音已含人声）。 */
  | { type: 'client.cue'; cue: 'asr-down' | 'tts-down' | 'llm-down' | 'network-down' }
  | { type: 'error'; code: ServerErrorCode; message: string }

/** 契约定义的错误码 */
export type ServerErrorCode =
  | 'AUTH_FAILED'
  | 'ASR_TIMEOUT'
  | 'LLM_ERROR'
  | 'RATE_LIMITED'
  | 'SESSION_CLOSED'
