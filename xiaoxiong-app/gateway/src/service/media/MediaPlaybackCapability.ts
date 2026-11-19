/**
 * 媒体播放系统能力层 —— 纯机制，零业务。
 *
 * 职责边界（用户明确要求「系统能力不能有业务代码」，改动前务必读这段）：
 *  - 本层只认 MediaAsset 这个通用媒体描述，完全不知道 music/news/poem/baike 这些业务类型；
 *    意图识别、数据获取、字幕文本生成与铺行都在各 skill/工具里，不许搬进本层。
 *  - 本层只做「怎么播」：预热音轨、生成 dash 短链、下发 media.play / media.subtitle、
 *    维护播放状态机（暂停/继续/停止/重播/当前媒体）。「播什么、字幕写什么」不归本层。
 *  - 所有播放（用户显式点歌走 skill 直连、LLM 主动放歌走 play_media 工具）都必须经过
 *    本层的 play()，状态才有唯一写入方，避免两条路径各记一套导致「暂停/重播说没在播」。
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
import { needsProxy } from '../music'
import { adtsKeyFor, ensureAdtsFile } from '../../controller/musicStreamController'

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

/** 外部依赖：全部注入，便于单测 mock，能力层不自己 import 数据获取逻辑。 */
export interface MediaPlaybackDeps {
  send: (event: ServerEvent) => void
  /** dash 音轨后台预热（本层只触发、不 await）。 */
  ensureAdtsFile: (raw: string) => Promise<string>
  needsProxy: (channel?: string, url?: string) => boolean
  adtsKeyFor: (raw: string) => string
  getNowPlayingInfo: () => { title: string; artist?: string; contentType?: string } | null
}

export class MediaPlaybackCapability {
  private lastMusic: MediaAsset | null = null
  private lastTts: MediaAsset | null = null
  private musicActive = false
  private ttsMediaActive = false
  private subtitleActive = false
  private subtitleLines: SubtitleLine[] | null = null
  private autoSubtitle = true

  constructor(private readonly deps: MediaPlaybackDeps) {}

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

/** 默认依赖：接真实实现，供生产装配；单测注入 mock。 */
export function createDefaultMediaPlaybackDeps(send: (e: ServerEvent) => void): MediaPlaybackDeps {
  return {
    send,
    ensureAdtsFile,
    needsProxy,
    adtsKeyFor,
    getNowPlayingInfo: () => null,
  }
}
