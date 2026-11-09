/** 服务端下行事件（与 contracts/README.md 保持一致） */
export type ServerEvent =
  | { type: 'asr.partial'; text: string }
  /** queueRemaining 是服务端给出的队列剩余数，客户端据此同步，不靠本地猜测 */
  | { type: 'asr.final'; text: string; queueRemaining: number }
  /** 当前轮还没播完，这句只识别不打断，排进队列 */
  | { type: 'asr.queued'; text: string; position: number; size: number; message: string }
  /** 这句没被接收（队列满），message 是服务端本地化的原因；reason 标记队列满 */
  | { type: 'asr.rejected'; text: string; message: string; reason: 'queue-full' }
  | { type: 'llm.thinking'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done' }
  | { type: 'tts.start'; format: string; sampleRate: number }
  | { type: 'tts.stop' }
  | { type: 'tts.end' }
  | { type: 'audio.duplex'; mode: 'half' | 'full' }
  /** 让客户端播放一段音频流（电台/歌曲）：客户端用独立播放器，不与 TTS 冲突。
   *  loop 为「总共播放几遍」，缺省/1 表示不循环；客户端播完最后一遍进入「已播完」态。 */
  | { type: 'media.play'; url: string; title: string; channel?: string; loop?: number }
  /** 让客户端停止当前播放 */
  | { type: 'media.stop' }
  /** 让客户端暂停当前播放 */
  | { type: 'media.pause' }
  /** 让客户端恢复（继续）播放 */
  | { type: 'media.resume' }
  /** 让客户端展示某首歌的歌词 */
  | { type: 'media.lyrics'; title: string; artist?: string; lyrics: string }
  /** 让客户端把音乐音量设到指定值（0–1）；语音「音量 30% / 调大 / 调小」时由网关下发 */
  | { type: 'media.volume'; volume: number }
  /** 服务端需要设备位置时才下发，客户端据此请求定位授权并上报 session.location；不在建连时主动要 */
  | { type: 'client.location.request' }
  /** 让客户端播一条「能力不可用」提示音（网关 /static/cues/<cue>.mp3）；
   *  ASR/TTS/LLM 未就绪时网关没法用语音播报，改发预录提示音让用户听得见。cue 为提示音名。 */
  | { type: 'client.cue'; cue: 'asr-down' | 'tts-down' | 'llm-down' | 'network-down' }
  | { type: 'error'; code: string; message: string }

export type SessionMode = 'wake' | 'dialog'

/** 客户端会话传输层：真实实现走 WebSocket */
export interface AssistantTransport {
  /** 建立连接并按模式开启会话（wake=只做识别用于唤醒词检测） */
  connect(mode?: SessionMode): Promise<void>
  /** 在当前连接上切换会话模式（重新下发 session.start） */
  startSession(mode: SessionMode): void
  /** 连接是否仍可用：网关重启后本地标志会过期，必须以此为准 */
  isConnected(): boolean
  /** 订阅 WS 连接状态变化（网关是否当前连通）；订阅时立即回灌一次当前值 */
  onStatusChange(listener: (connected: boolean) => void): () => void
  /** 订阅「正在建连」状态变化（含自动重连每次尝试）；订阅时立即回灌一次当前值 */
  onConnecting(listener: (value: boolean) => void): () => void
  /** 订阅自动重连耗尽（连不上且不再自动重试）；订阅时若已耗尽立即回灌一次 */
  onReconnectExhausted(listener: () => void): () => void
  sendAudioChunk(chunk: ArrayBuffer): void
  sendCancel(): void
  /** 客户端点「换一首 / 换个风格」：下发 music.next 让网关解析下一首 */
  requestMusicNext(genre?: string): void
  /** 本地播放队列真正清空后回执，网关据此才消费排队的下一句 */
  notifyPlaybackDone(): void
  /** 客户端点「换一首 / 换个风格」：请网关用当前音乐源解析下一首 */
  requestMusicNext(genre?: string): void
  /** 客户端拖动音量滑块后上报当前音量（0–1），让网关保持音量状态同步 */
  reportVolume(volume: number): void
  close(): void
  onEvent(listener: (event: ServerEvent) => void): () => void
  /** 下行二进制音频帧（TTS PCM）；不支持时返回空订阅函数 */
  onAudio(listener: (chunk: ArrayBuffer) => void): () => void
}
