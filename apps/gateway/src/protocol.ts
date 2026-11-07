/**
 * 网关 ↔ 客户端的 WebSocket 语音协议类型。
 * 与仓库根目录 contracts/README.md 保持一致：文本帧走 JSON 控制消息，
 * 二进制帧走音频（客户端→服务端=麦克风 PCM 16k/16bit/mono，
 * 服务端→客户端=TTS PCM pcm16/24000），方向天然区分上下行。
 */

export type Lang = 'zh-CN'

/** 设备上报的位置：经纬度必填，address 为客户端反向地理编码得到的可读地址（城市/街道） */
export interface LocationInfo {
  latitude: number
  longitude: number
  address?: string
}

/** 客户端上报的地图服务商配置：选中的逆地理编码服务商 + 该服务商的 Key（byok，存本机）。 */
export interface GeocodeInfo {
  /** tianditu=天地图；tencent=腾讯；amap=高德；baidu=百度。均免费提供逆地理编码。 */
  provider: 'tianditu' | 'tencent' | 'amap' | 'baidu'
  /** 该服务商的 API Key；为空时网关退回客户端自带地址或网关兜底 Key。 */
  key: string
}

/** 音乐播放源配置：客户端设置页选择厂商并填参数，随会话上报（BYOK，与 asr/llm/tts 同构）。 */
export interface MusicInfo {
  /** 播放源厂商：soma=免费网络电台；custom=自定义电台 URL；netease/qq/spotify=正版音乐服务 */
  provider: string
  /** 该厂商的参数字典（如 custom 的 streamUrl，或 spotify 的 clientId/clientSecret），由设置页按厂商字段保存 */
  params: Record<string, string | number | boolean>
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
      /** 地图服务商配置（逆地理编码用）：客户端设置页选择并填 Key，随会话上报 */
      geocode?: GeocodeInfo
      /** 音乐播放源配置：客户端设置页选择厂商并填参数，随会话上报；智能体据此下发 media.play 的播放地址 */
      music?: MusicInfo
      /** wake=只做 ASR（用于本地唤醒词检测，不跑 LLM/TTS）；dialog=完整对话，默认 */
      mode?: 'wake' | 'dialog'
    }
  | { type: 'session.cancel' }
  | { type: 'session.end' }
  /** 客户端定位更新：连接后或位置变化时补报/刷新最新位置 */
  | { type: 'session.location'; latitude: number; longitude: number; address?: string }
  /** 客户端本地播放队列清空后回执：网关据此才消费排队的下一句 */
  | { type: 'session.playback_done' }

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
  /** 让客户端播放一段音频流（如 SomaFM 网络电台）；客户端用独立播放器，不与 TTS 冲突 */
  | { type: 'media.play'; url: string; title: string; channel?: string }
  /** 让客户端停止当前播放 */
  | { type: 'media.stop' }
  /** 让客户端展示某首歌的歌词 */
  | { type: 'media.lyrics'; title: string; artist?: string; lyrics: string }
  | { type: 'error'; code: ServerErrorCode; message: string }

/** 契约定义的错误码 */
export type ServerErrorCode =
  | 'AUTH_FAILED'
  | 'ASR_TIMEOUT'
  | 'LLM_ERROR'
  | 'RATE_LIMITED'
  | 'SESSION_CLOSED'
