/**
 * 媒体播放系统能力层 —— 纯机制，零业务。
 *
 * 职责边界（用户明确要求「系统能力不能有业务代码」「解析媒体也是通用能力」，改动前务必读这段）：
 *  - 本层是完整的「音频系统能力」：语义参数 → 解析媒体 → 预热/短链 → 播放 → 字幕 → 状态机 → 通用指令，
 *    全链路在这里。skill 只传语义参数（genre/query/动作）+ 口播，不碰解析、不碰 MediaAsset、不碰源。
 *  - 本层仍完全不知道 music/news/poem/baike 这些业务类型：解析通过注入的 MediaResolver 完成
 *    （源实现由外部注入、可替换），字幕文本由注入的 resolver 拉取；本层只认通用 MediaAsset。
 *  - 意图识别、口播文案在各 skill 里，不进本层。
 *  - 所有播放（skill 直连 / play_media 工具）都经过本层，状态唯一写入方，避免两条路径各记一套。
 *
 * 吸收的踩坑（都是真机实测，删注释等于埋雷）：
 *  - dash 长 URL 936 字节即被 DCloud 下载器截断，必须转 ADTS 走本地短链 audioPath + proxy:false；
 *  - 音轨预热 9MB+/11MB+ 要几秒，必须后台预热、不 await，否则播放器迟迟不出现；
 *  - 确认口播不能 await（会阻塞到 playback_done，播放器永远出不来）；
 *  - 字幕行必须复用上次成功的（网络波动时别把歌词覆盖成「暂无字幕」）；
 *  - pause 不清 active（暂停≠停止，媒体还在，保留 lastXxx 供继续/重播）；
 *  - stop 一次清全部状态；
 *  - TTS 类字幕由调用方按真实音频时长铺好传入（本层不重算、不生成）。
 */
import type { ServerEvent, SubtitleLine } from '../../protocol'
// 系统能力不依赖 music/news/poem/baike 任何业务域：dash 预热/代理判定/短链 key 全部由 deps 注入。

/** 通用媒体描述。注意：没有 kind:news/poem/baike 等业务字段——业务类型不进系统能力层。 */
export interface MediaAsset {
  /** 仅区分两种播放机制：music=媒体音轨(可能 dash 短链)，tts=已落盘的语音合成音频。不是业务类型。 */
  source?: 'music' | 'tts'
  url: string
  title: string
  audioPath?: string
  cover?: string
  channel?: string
  artist?: string
  /** 内容类型（评书/戏曲/歌曲），只用于对外快照的措辞提示，本层不据此分支。 */
  contentType?: string
  loop?: number
  /** 已由调用方铺好时间轴的字幕行；本层原样下发，不生成不重算。 */
  lines?: SubtitleLine[]
}

export interface PlayOptions {
  /** 播放确认口播（本层不 await，防阻塞播放器出现）。 */
  confirm?: string
  /** 复用上次成功的字幕行，而不是下发本次 lines（防歌词被覆盖成暂无字幕）。 */
  reuseSubtitle?: boolean
  /** 口播能力（由会话层注入 speakReply）。 */
  speak?: (text: string) => Promise<void>
}

export interface PlaybackSnapshot {
  /** 当前/上次播放的媒体（tts 优先于 music，供「重新播放」）。 */
  current: MediaAsset | null
  musicActive: boolean
  ttsMediaActive: boolean
  subtitleActive: boolean
  subtitleLines: SubtitleLine[] | null
}

/**
 * 媒体解析能力（系统能力的一部分，由外部注入实现 —— 换源只换这个实现，本层与 skill 都不动）。
 * 语义参数进、通用 MediaAsset 出；本层不知道它背后是哪家源。
 */
export interface MediaResolver {
  /** 按语义参数解析出要播的媒体；null 表示没找到。 */
  resolve(params: { genre?: string; artist?: string; query?: string }): Promise<MediaAsset | null>
  /** 换一首（可选）：同类型或指定风格；不支持的解析器可省略，本层回退到 resolve。 */
  next?(params?: { genre?: string }): Promise<MediaAsset | null>
  /** 拉同源字幕（可选）：返回带时间轴的行；拉不到返回 null。 */
  getSubtitle?(title: string, artist?: string): Promise<SubtitleLine[] | null>
}

/** 外部依赖：全部注入，便于单测 mock，能力层不自己 import 数据获取逻辑。 */
export interface MediaPlaybackDeps {
  send: (event: ServerEvent) => void
  /** dash 音轨后台预热（本层只触发、不 await）。 */
  ensureAdtsFile: (raw: string) => Promise<string>
  needsProxy: (channel?: string, url?: string) => boolean
  adtsKeyFor: (raw: string) => string
  getNowPlayingInfo: () => { title: string; artist?: string; contentType?: string } | null
  /** 媒体解析能力（可换源）；未注入时高层语义方法返回 false，play(MediaAsset) 仍可用。 */
  resolver?: MediaResolver
}

export class MediaPlaybackCapability {
  private lastMusic: MediaAsset | null = null
  private lastTts: MediaAsset | null = null
  private musicActive = false
  private ttsMediaActive = false
  private subtitleActive = false
  private subtitleLines: SubtitleLine[] | null = null
  private autoSubtitle = true
  /** 网关认定的当前音量权威值（0–1），每次新播放重置为默认值、滑块回执/语音增减同步。 */
  private musicVolume = 0.5

  constructor(private readonly deps: MediaPlaybackDeps) {}

  /** 当前音量（0–1）。 */
  getVolume(): number {
    return this.musicVolume
  }

  /** 设音量（0–1，越界收敛），下发 media.volume。返回生效值。 */
  setVolume(value: number): number {
    const v = Math.min(1, Math.max(0, value))
    this.musicVolume = v
    this.deps.send({ type: 'media.volume', volume: v })
    return v
  }

  /** 客户端滑块回执：只同步状态、不下发事件（避免回声式回环）。 */
  syncVolumeFromClient(value: number): void {
    if (Number.isFinite(value)) this.musicVolume = Math.min(1, Math.max(0, value))
  }

  /**
   * 采纳一次「已在编排层下发」的音乐播放：只同步状态、不重复发 media.play。
   * 过渡期用——playTrack 仍自己拼 dash 短链下发，但状态必须收敛到能力层，
   * 这样通用控制（暂停/重播/循环/字幕）读到的才是真实在播内容。
   */
  adoptMusic(asset: MediaAsset, lines?: SubtitleLine[]): void {
    this.lastMusic = asset
    this.musicActive = true
    if (lines?.length) {
      this.subtitleLines = lines
      this.subtitleActive = true
    } else if (asset.lines?.length) {
      this.subtitleLines = asset.lines
      this.subtitleActive = true
    }
  }

  /** 同步字幕显示状态（编排层 emitAutoSubtitle 拉到字幕后调用）。 */
  adoptSubtitle(lines: SubtitleLine[] | null): void {
    this.subtitleLines = lines
    this.subtitleActive = !!lines?.length
  }

  /**
   * 播放一段媒体（唯一的播放入口）。
   * 流程顺序刻意为之：先记状态、再后台预热、再口播（不 await）、最后立即下发 media.play，
   * 让播放器尽早出现；字幕是尽力而为，失败不影响播放。
   */
  play(asset: MediaAsset, opts: PlayOptions = {}): void {
    if (asset.source === 'tts') {
      this.lastTts = asset
      this.ttsMediaActive = true
    } else {
      this.lastMusic = asset
      this.musicActive = true
    }
    this.subtitleActive = false

    // dash 纯音轨（.m4s）后台预热转 ADTS，不 await——等它要几秒，播放器就迟迟不出现。
    if (this.needsDashShortLink(asset)) {
      void this.deps.ensureAdtsFile(asset.url).catch(() => undefined)
    }
    // 口播确认不 await：空闲直连路径下 speakReply 会自建「等播完回执」的等待，
    // await 它会阻塞到 playback_done，播放器永远出不来。
    if (opts.confirm && opts.speak) void opts.speak(opts.confirm)

    // 字幕尽力而为：reuse=true 时复用上次成功的行（网络波动别把歌词覆盖成暂无字幕）。
    if (asset.lines || opts.reuseSubtitle) {
      this.emitSubtitle(asset.title, asset.artist, asset.lines ?? [], opts.reuseSubtitle)
    }

    this.deps.send({
      type: 'media.play',
      url: asset.url,
      title: asset.title,
      ...(asset.channel ? { channel: asset.channel } : {}),
      // dash 必须走本地 ADTS 短链，且不能让客户端代理长 URL（936 字节即断，真机实测）。
      ...(this.needsDashShortLink(asset)
        ? { proxy: false, audioPath: `music/s/${this.deps.adtsKeyFor(asset.url)}.aac` }
        : this.deps.needsProxy(asset.channel, asset.url)
          ? { proxy: true }
          : {}),
      ...(asset.audioPath ? { audioPath: asset.audioPath } : {}),
      ...(asset.source ? { source: asset.source } : {}),
      ...(asset.cover ? { cover: asset.cover } : {}),
      ...(asset.loop && asset.loop > 1 ? { loop: asset.loop } : {}),
    })
  }

  /** 是否是需要转 ADTS 本地短链的 dash 音轨（纯机制判断，与业务无关）。 */
  private needsDashShortLink(asset: MediaAsset): boolean {
    return this.deps.needsProxy(asset.channel, asset.url) && asset.url.includes('.m4s')
  }

  /** 下发字幕行。reuse=true 且上次有缓存时用缓存，否则用传入 lines。 */
  emitSubtitle(title: string, artist: string | undefined, lines: SubtitleLine[], reuse = false): boolean {
    if (reuse && this.subtitleLines) {
      this.deps.send({ type: 'media.subtitle', title, ...(artist ? { artist } : {}), lines: this.subtitleLines })
      this.subtitleActive = this.subtitleLines.length > 0
      return this.subtitleActive
    }
    this.deps.send({ type: 'media.subtitle', title, ...(artist ? { artist } : {}), lines })
    this.subtitleLines = lines
    this.subtitleActive = lines.length > 0
    return this.subtitleActive
  }

  /** 关闭字幕面板（如实反馈由调用方根据 subtitleActive 决定，本层只管下发）。 */
  closeSubtitle(): void {
    this.deps.send({ type: 'media.subtitle', title: '', lines: [], close: true })
    this.subtitleActive = false
  }

  setAutoSubtitle(on: boolean): void {
    this.autoSubtitle = on
  }

  isAutoSubtitle(): boolean {
    return this.autoSubtitle
  }

  /** 暂停 / 继续：绝不清 active（暂停≠停止，媒体还在，继续/重播要认它）。 */
  pause(): boolean {
    if (!this.musicActive && !this.ttsMediaActive) return false
    this.deps.send({ type: 'media.pause' })
    return true
  }

  resume(): boolean {
    if (!this.musicActive && !this.ttsMediaActive) return false
    this.deps.send({ type: 'media.resume' })
    return true
  }

  /** 停止：一次清全部状态（音乐/tts/字幕/新闻上下文由调用方另清）。 */
  stop(): boolean {
    if (!this.musicActive && !this.ttsMediaActive) return false
    this.deps.send({ type: 'media.stop' })
    this.musicActive = false
    this.ttsMediaActive = false
    this.subtitleActive = false
    return true
  }

  /**
   * 重新播放当前媒体：tts 优先于 music（用户播了百科再说「重新播放」要重播百科不是上一首歌）。
   * 返回是否真的重播了，供调用方决定口播「没在播放」还是确认句。
   */
  replay(): boolean {
    const asset = this.lastTts ?? this.lastMusic
    if (!asset) return false
    if (asset.lines?.length) this.emitSubtitle(asset.title, asset.artist, asset.lines, true)
    const confirm = `重新播放${asset.title}`
    this.play(asset, { confirm, reuseSubtitle: true })
    return true
  }

  /**
   * 高层语义播放：skill 只传语义参数，本层用注入的 resolver 解析出媒体并播放。
   * 返回解析到的媒体（供 skill 口播标题）；null 表示没找到/未注入 resolver。
   * 口播确认由 skill 传 confirm（本层不生成文案）——这里只负责解析+播放链路。
   */
  async playByQuery(
    params: { genre?: string; artist?: string; query?: string },
    opts: PlayOptions = {},
  ): Promise<MediaAsset | null> {
    const resolver = this.deps.resolver
    if (!resolver) return null
    const asset = await resolver.resolve(params)
    if (!asset) return null
    this.play(asset, opts)
    return asset
  }

  /** 换一首：优先 resolver.next，不支持则回退 resolve。返回媒体或 null。 */
  async nextAsset(params: { genre?: string } = {}, opts: PlayOptions = {}): Promise<MediaAsset | null> {
    const resolver = this.deps.resolver
    if (!resolver) return null
    const asset = (resolver.next ? await resolver.next(params) : null) ?? await resolver.resolve(params)
    if (!asset) return null
    this.play(asset, opts)
    return asset
  }

  /** 拉同源字幕并下发（系统能力）：autoSubtitle 关闭时不显示、拉不到不覆盖已有字幕。 */
  async ensureSubtitle(title: string, artist?: string, reuse = false): Promise<boolean> {
    const resolver = this.deps.resolver
    if (!resolver?.getSubtitle) return false
    if (reuse && this.subtitleLines) return this.emitSubtitle(title, artist, [], true)
    try {
      const lines = await resolver.getSubtitle(title, artist)
      if (!lines?.length) return false
      return this.emitSubtitle(title, artist, lines)
    } catch {
      return false
    }
  }

  snapshot(): PlaybackSnapshot {
    return {
      current: this.lastTts ?? this.lastMusic,
      musicActive: this.musicActive,
      ttsMediaActive: this.ttsMediaActive,
      subtitleActive: this.subtitleActive,
      subtitleLines: this.subtitleLines,
    }
  }

  /** 上次音乐媒体（选歌上下文用，必须与 tts 分开——选歌不能混进百科/诗词）。 */
  getLastMusic(): MediaAsset | null {
    return this.lastMusic
  }

  /** 选歌解析出曲目后提前记录（此时还没真正 play，但要供后续「换一首沿用歌手」判断）。 */
  setLastMusic(asset: MediaAsset): void {
    this.lastMusic = asset
  }

  /** 选歌解析出曲目后提前标记音乐在播（业务判断副产物，不发 media.* 事件）。 */
  markMusicActive(): void {
    this.musicActive = true
  }

  /** 当前字幕是否显示（「关闭字幕」如实反馈用）。 */
  hasSubtitle(): boolean {
    return this.subtitleActive
  }

  /** 上次成功的字幕行（开字幕时重发用）。 */
  getSubtitleLines(): SubtitleLine[] | null {
    return this.subtitleLines
  }

  /** 供系统提示注入：当前媒体标题/歌手/内容类型（业务措辞由 agent 决定，本层只给数据）。 */
  getNowPlaying(): { title: string; artist?: string; contentType?: string } | null {
    if (!this.musicActive) return this.deps.getNowPlayingInfo()
    const a = this.lastMusic
    return a ? { title: a.title, ...(a.artist ? { artist: a.artist } : {}), ...(a.contentType ? { contentType: a.contentType } : {}) } : null
  }

  /** 会话彻底结束/重开：清状态（由 voiceSessionService 在 end/新 start 时调，防跨会话残留）。 */
  reset(): void {
    this.lastMusic = null
    this.lastTts = null
    this.musicActive = false
    this.ttsMediaActive = false
    this.subtitleActive = false
    this.subtitleLines = null
    this.autoSubtitle = true
  }
}

/**
 * 默认依赖工厂：dash 相关的真实实现由装配方（voiceSessionService）注入——
 * 系统能力层不 import controller/music 等任何业务域，保持能力层零业务依赖。
 * 单测直接构造 MediaPlaybackDeps mock，不走这个工厂。
 */
export function createMediaPlaybackDeps(params: {
  send: (e: ServerEvent) => void
  ensureAdtsFile: (raw: string) => Promise<string>
  needsProxy: (channel?: string, url?: string) => boolean
  adtsKeyFor: (raw: string) => string
}): MediaPlaybackDeps {
  return {
    ...params,
    getNowPlayingInfo: () => null,
  }
}
