import type { AsrProvider } from '../asr'
import type { TtsProvider } from '../tts'
import type { AgentService } from './agentService'
import type { DataService } from './dataService'
import type { ClientMessage, Lang, LocationInfo, ServerEvent, ServerErrorCode, SubtitleLine } from '../protocol'
import type { GatewayConfig } from '../config'
import type { AsrConfig, LlmConfig, TtsConfig } from '../config'
import type { VoiceConfig, ResolvedCapabilities } from '../voiceConfig'
import { createMusicSource, needsProxy, type MusicSource } from './music'
import { MusicSourceNotImplementedError } from './music/types'
import { genreToKeyword, isGenericPlayPhrase, isSpokenContentRequest, detectContentType } from './music/types'
import { formatMemories, formatDeals, type MemoryStore, type RequestLocation } from './tools'
import { createDealsTool } from './tools/dealsTool'
import { createSmzdmSource } from './deals'
import { detectDealsCommand } from './dealsControl'
import {
  searchCandidates,
  needsCandidateList,
  candidateQuery,
  parseSelection,
  looksLikeBareMusicQuery,
  contentWords,
  filterByCurrentArtist,
  isArtistBrowse,
  type MusicCandidate,
  type CandidateFetcher,
} from './music/musicCandidates'
import { detectMusicCommand, parseLoopCount, hasAgainMarker } from './musicControl'
import { detectVolumeCommand } from './volumeControl'
import { detectMemoryCommand } from './memoryControl'
import { detectSubtitleCommand } from './subtitleControl'
import { detectPlayModeCommand } from './playModeControl'
import { messages } from '../i18n'
import { isNoise, resemblesSpoken } from '../asr/noiseFilter'
import { sanitizeForSpeech } from '../tts/sanitize'
import { EnergyVad } from '../vad/energyVad'
import { EchoGuard } from '../vad/echoGuard'
import { buildHealth } from './health'

/** 播报期间最多排几句用户插话，超出直接拒收。 */
const MAX_QUEUE = 3

/** 单个语音会话的业务编排：ASR → 智能体 → TTS，并记录日志到数据库。 */
export interface VoiceSessionDeps {
  agentFactory: (
    llm: LlmConfig,
    lang: Lang,
    timezone?: string,
    locationProvider?: () => LocationInfo | null,
    getMusicSource?: () => MusicSource | undefined,
    emit?: (m: ServerEvent) => void,
    memoryStore?: MemoryStore,
    memoryContext?: string,
    requestLocation?: RequestLocation,
    autoSubtitle?: boolean,
    defaultLoop?: number,
    defaultVolume?: number,
    autoLoop?: boolean,
    getNowPlaying?: () => { title: string; artist?: string; contentType?: string } | null
  ) => AgentService
  /** 按解析出的能力配置构造 ASR/TTS 实例（voice 来自 session.start，故在 start 时构建） */
  createAsr: (cfg: AsrConfig) => AsrProvider
  createTts: (cfg: TtsConfig) => TtsProvider
  /** 把客户端设置的语音服务配置展开成三套能力配置 */
  resolveVoice: (voice?: VoiceConfig) => ResolvedCapabilities
  data: DataService
  send: (event: ServerEvent) => void
  sendAudio: (bytes: Uint8Array) => void
  asrEndpointMs: number
  /** 构造音乐播放源；测试可注入桩避免联网，缺省用网关内置的无配置源 */
  musicSourceFactory?: () => MusicSource
  /** 检索候选歌曲（MusicBrainz）；测试可注入桩避免联网 */
  candidateFetcher?: CandidateFetcher
  /** 查询商品/好价：测试可注入桩避免联网，缺省用 createDealsTool 真实查询 */
  dealsQuery?: (keyword?: string) => Promise<string>
  /**
   * 设备稳定标识（来自客户端上报的 deviceId）；用于命令日志/会话落库归属设备。
   * 缺省空：旧客户端未上报，会话不进注册表、不复用。
   */
  deviceId?: string | null
  /** 会话显式结束（session.end）时回调：控制器据此从注册表移除，下次 start 视为全新 */
  onEnded?: () => void
  /** 懒加载定位的等待超时（毫秒）：客户端取不到/拒绝/离线时兑现为 null；测试可压短 */
  locationRequestTimeoutMs?: number
  /** 网关运行配置：用于会话建连时一次性探测 ASR/TTS/LLM 就绪状态，未就绪则下发提示音。
   *  注入了 capabilityProbe 时可省略（测试用）；生产路径始终传入。 */
  config?: GatewayConfig
  /**
   * 能力就绪探测（返回各能力 reachable 与否）；缺省走网关 /api/health 同一套带缓存逻辑。
   * 测试可注入桩，避免真打 ASR/TTS/LLM 服务、又能精确控制「哪些能力不可用」。
   */
  capabilityProbe?: () => Promise<import('./health').HealthReport | null>
}

/**
 * “换一首 / 下一首 / 换个风格” 之类指令里，若用户没指定新的歌手/风格，返回 undefined
 * （让音乐源沿用当前上下文，放同歌手/同风格的下一首）；否则返回收敛后的关键词。
 * 这样「换一首」不会因没给风格而被路由到完全不相关的电台/歌曲。
 */
function nextPreference(text: string): string | undefined {
  if (!text) return undefined
  let kw = text
    .replace(
      /换一?首|下一?首|换个?风格|换一?个风格|切歌|来点别的|换台|换一?段|换段|下一?段|换一?集|换集|下一?集|换一?部|换部|换一?回|换回|再来一?段|来段别的|来个别的|换一个|换个|换一下|再来一个/g,
      ''
    )
    .replace(/的/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  kw = kw.replace(/^[放播唱听]\s*/, '')
  if (!kw) return undefined
  // 只剩泛化点歌词（歌/音乐/放首歌…）也算“没给具体新偏好”
  if (isGenericPlayPhrase(kw)) return undefined
  return genreToKeyword(kw)
}

export class VoiceSessionService {
  private active = false
  private cancelled = false
  /** 当前是否有一轮回答在跑（含思考、生成、播报） */
  private processing = false
  private endpointTimer: ReturnType<typeof setTimeout> | null = null
  private lang: Lang = 'zh-CN'
  /** 用户时区（IANA），时间类工具按它返回；缺省东 8 区 */
  private timezone = 'Asia/Shanghai'
  /** 设备最近一次上报的位置；位置类工具实时读取它 */
  private location: LocationInfo | null = null
  /** 懒加载定位：位置/天气工具需要位置但会话尚无时，挂起的 resolver；到达后统一兑现 */
  private pendingLocation: Array<(loc: LocationInfo | null) => void> = []
  /** 是否已向客户端发过 client.location.request（避免并发工具重复下发） */
  private locationRequestSent = false
  private locationRequestTimer: ReturnType<typeof setTimeout> | null = null
  /** 音乐播放源：无配置、始终可用（SomaFM 电台 + B 站搜索兜底），随会话构建 */
  private musicSource: MusicSource | undefined = undefined
  /**
   * 最近一次下发的曲目，供「循环播放」复用同一首重播。
   * contentType 记住当前播的是歌 / 评书 / 戏曲 / 电影…（歌曲为 undefined），
   * 后续换内容、失败提示都据此措辞，避免一律当成「放歌」。
   */
  private lastTrack: { url: string; title: string; channel?: string; cover?: string; artist?: string; contentType?: string } | null = null
  /** 自动字幕开关：播放音乐时同源字幕是否自动拉取并展示；来自客户端设置（缺省开启）。 */
  private autoSubtitle = true
  /** 上一次成功下发的同源字幕，供「循环播放」重播同一首时复用，避免重新拉取失败把字幕覆盖成「暂无字幕」 */
  private lastSubtitleLines: SubtitleLine[] | null = null
  /** 当前是否真的有字幕面板在显示：仅在成功下发非空字幕时为 true，用于「关闭字幕」时如实反馈 */
  private subtitleActive = false
  /** 最近一次 session.start 带下来的语音来源配置：供 announceCapabilityProblems 按「实际会用的那套能力」
   *  探测就绪状态（而非永远探测网关默认的内置），与 /api/health 的 provider-aware 探测保持一致。 */
  private lastVoice: VoiceConfig | undefined = undefined
  /** 跨轮记忆相关引用（来自设备长期记忆），首次建连时拉取并缓存，重武装时复用，避免重复拉取。 */
  private memoryStore: MemoryStore | undefined = undefined
  private memoryContext: string | undefined = undefined
  /** 上次建 agent 用的 LLM 配置指纹：重武装时若来源未变则保留原 agent（对话历史不丢），
   *  仅当来源真变了（如切到 DashScope）才重建 LLM 客户端，让「切换来源」立即生效。 */
  private lastLlmKey: string | null = null
  /** 默认循环播放次数（含当前这一遍）；0/1 表示不循环，缺省 3。每次新播放经 media.play 的 loop 带入。 */
  private defaultLoop = 3
  /** 默认播放音量（0–1），缺省 0.5；每次新播放开始时经 media.volume 下发，供「调大/调小」相对增减。 */
  private defaultVolume = 0.5
  /** 是否自动循环播放：开启后每次新播放默认按 defaultLoop 遍数循环；关闭（缺省）则只在显式「循环 N 遍」或手动循环时才循环。 */
  private autoLoop = false
  /** 当前是否正在播放（播放/切歌/循环置真，停止置假）。决定「点歌按当前歌手优先」是否生效：
   *  仅当用户正处于某个歌手的播放会话时才自动选同歌手版本；已停止则老老实实列选项让用户选。 */
  private musicActive = false
  /** 音乐播放音量（0–1）：网关认定的权威值，随客户端滑块回执同步；语音「调大/调小」相对增减用。 */
  private musicVolume = 0.5
  /** 待用户用语音选择的候选歌曲列表：口播编号后挂起，下一句解析「第几首 / 歌名」 */
  private pendingCandidates: { items: MusicCandidate[]; query: string } | null = null
  /** 上一轮「换一首」没找到同类型的歌，正等用户确认是否换其它风格（不直接乱播） */
  private pendingNextFallback = false
  private mode: 'wake' | 'dialog' = 'dialog'
  private sessionRowId = 0
  private agent: AgentService | null = null
  private readonly deviceId: string | null = null
  /** 本次会话的 ASR / TTS 实例：在 start() 里按客户端设置的语音配置构建（地址/密钥/参数来自设置） */
  private asr!: AsrProvider
  private tts!: TtsProvider
  /**
   * 客户端持续上行（含静音），所以句末不再靠「收不到数据」判断：
   * 只有 VAD 判为语音的帧才喂给 ASR，最后一个人声帧之后静音够久才定稿。
   */
  private readonly vad = new EnergyVad()
  /** 轮次编号：旧轮的在途回调据此作废，避免两轮抢着发事件。 */
  private turn = 0
  /** 是否已经给客户端发过 tts.start（音频帧下发中）。 */
  private speaking = false
  /**
   * 客户端还在播这一句：从 tts.start 起，到 playback_done 回执（或超时）为止。
   * 比 speaking 更晚结束 —— tts.end 只代表下发完，尾音还在扬声器里，
   * 这段时间的上行帧照样是回声，门控必须继续生效。
   */
  private playbackPending = false
  /** AEC 失效兜底：连续被自己的回声打断就降级成半双工。 */
  private readonly echo = new EchoGuard()
  /** 当前是否已通知客户端处于半双工，避免重复下发。 */
  private halfDuplex = false
  /** 当前轮还没播完时识别到的用户插话，播完后依次交给大模型。 */
  private readonly queue: string[] = []
  /** 最近送进 TTS 的原文，用于把「收回来的自己的声音」判成回声丢弃。 */
  private readonly spoken: string[] = []
  /**
   * 最后一次下发音频之后的回声保护窗口（毫秒）：窗口内定稿的文本一律按回声对待。
   * 播放结束（含被打断）后仍留一小段尾巴，盖住扬声器余音经空气/回路传回麦克风的延迟。
   */
  private echoUntil = 0
  /** 本轮已下发的音频字节数，用于估算播放时长做握手超时兜底。 */
  private downlinkBytes = 0
  /** 等待客户端「播完」回执的 resolve；processing 会一直保持到它触发。 */
  private playbackResolve: (() => void) | null = null
  private playbackTimer: ReturnType<typeof setTimeout> | null = null
  /** 定稿串行链：多个 endpoint 定时器重叠时逐句处理，不丢句也不抢同一段缓冲。 */
  private finalizeChain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: VoiceSessionDeps) {
    this.deviceId = deps.deviceId ?? null
  }

  /**
   * 重新挂载传输闭包：同一设备重连时，复用旧会话实例但换成新连接的 ws 收发。
   * 控制器在每次新建/复用连接后调用，确保 send/sendAudio 指向当前存活的 socket。
   */
  bindTransport(send: (event: ServerEvent) => void, sendAudio: (bytes: Uint8Array) => void): void {
    this.deps.send = send
    this.deps.sendAudio = sendAudio
  }

  handleText(raw: string): void {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw) as ClientMessage
    } catch {
      this.sendError('LLM_ERROR', '无法解析控制消息')
      return
    }
    switch (msg.type) {
      case 'session.start':
        this.location = msg.location ?? null
        // 音乐播放源：来自客户端设置页（session.start.playback.source），缺省百度；
        // 始终可用（SomaFM 电台 + B 站搜索兜底），音乐工具始终注册。
        this.musicSource = this.deps.musicSourceFactory
          ? this.deps.musicSourceFactory()
          : createMusicSource({ source: msg.playback?.source })
        // 自动字幕开关：来自客户端设置页（session.start.playback.autoSubtitle），缺省开启。
        this.autoSubtitle = msg.playback?.autoSubtitle ?? true
        // 默认循环次数 / 默认音量：来自客户端设置页（session.start.playback），缺省 3 / 0.5；
        // 不合法值归一到安全默认：循环次数取非负整数（0/1 均表示不循环），音量收敛到 [0,1]。
        // 音量状态以默认值为起点，后续语音「调大/调小」在其上相对增减。
        const pb = msg.playback
        this.defaultLoop = typeof pb?.defaultLoop === 'number' ? Math.max(0, Math.floor(pb.defaultLoop)) : 3
        this.defaultVolume = typeof pb?.defaultVolume === 'number' ? Math.min(1, Math.max(0, pb.defaultVolume)) : 0.5
        this.autoLoop = typeof pb?.autoLoop === 'boolean' ? pb.autoLoop : false
        this.musicVolume = this.defaultVolume
        void this.start(msg.sessionId, msg.lang, msg.timezone, msg.mode, msg.voice)
        // ASR/TTS/LLM 未就绪时，网关没法用语音播报，改为下发预录提示音，让用户「听得见地」知道；
        // 探测有 15s 缓存，连重连/重唤醒都便宜，不每次真打服务。不下发具体文案（提示音已含人声）。
        void this.announceCapabilityProblems()
        break
      case 'session.location':
        // 连接后或位置变化时刷新最新位置，不影响其它会话状态；
        // 同时兑现所有挂起的位置请求（懒加载定位：工具等这次上报才继续）
        this.location = {
          latitude: msg.latitude,
          longitude: msg.longitude,
          address: msg.address,
        }
        this.resolvePendingLocation()
        break
      case 'session.playback':
        // 播放设置实时更新：设置页改了播放源后由客户端随本消息推来，
        // 立即按新 source 重建音乐源，无需重连/重唤醒即可生效（下次点歌/换一首就用新源）。
        // 缺省/未知值回退到百度，与 session.start 同一套解析逻辑。
        this.musicSource = this.deps.musicSourceFactory
          ? this.deps.musicSourceFactory()
          : createMusicSource({ source: msg.source })
        // 自动字幕开关也可实时切换：设置页打开/关闭后由客户端随本消息推来。
        if (typeof msg.autoSubtitle === 'boolean') this.autoSubtitle = msg.autoSubtitle
        // 默认循环次数 / 默认音量同样可随设置页实时刷新，下次新播放（点歌/换一首）即生效。
        if (typeof msg.defaultLoop === 'number') this.defaultLoop = Math.max(0, Math.floor(msg.defaultLoop))
        if (typeof msg.defaultVolume === 'number') this.defaultVolume = Math.min(1, Math.max(0, msg.defaultVolume))
        if (typeof msg.autoLoop === 'boolean') this.autoLoop = msg.autoLoop
        break
      case 'session.cancel':
        this.cancel()
        break
      case 'session.end':
        this.end()
        break
      case 'session.playback_done':
        this.resolvePlayback()
        break
      case 'music.next':
        // 客户端点「换一首 / 换个风格」：直接用当前音乐源解析下一首并下发 media.play，
        // 不必走一轮 ASR→LLM（按钮已经是明确的指令）。
        void this.nextMusic(msg.genre)
        break
      case 'music.volume':
        // 客户端拖动滑块回执当前音量：保持网关音量状态同步，保证后续的「调大/调小」相对增减准确。
        if (Number.isFinite(Number(msg.volume))) {
          this.musicVolume = Math.min(1, Math.max(0, Number(msg.volume)))
        }
        break
    }
  }

  /**
   * 用当前音乐源解析「下一首」：优先用显式关键词，否则退回当前歌手重新搜该歌手的其它作品。
   * 若拿到的仍与当前同名（同一首的不同视频），再换一次，尽量给出不同歌名，
   * 避免「换一首却还是同一首歌、像没反应」。解析失败返回 null，由调用方决定提示或静默。
   */
  private async nextTrack(query?: string): Promise<{ url: string; title: string; channel?: string } | null> {
    const source = this.musicSource
    if (!source) return null
    try {
      let track = source.next ? await source.next(query) : await source.resolve(query)
      // 换一首若仍拿到与当前同名的那一首（同一首的不同视频 / 该歌手/类型只有这一首），
      // 再换一次，尽量给出不同歌名。若第二次仍是同名（或没结果），说明实在换不出不同歌
      // —— 返回 null 让调用方去问用户要不要换其它风格，而不是把同名歌重放一遍（像没反应）。
      if (this.lastTrack && track?.title === this.lastTrack.title) {
        const alt = source.next ? await source.next(query) : await source.resolve(query)
        if (!alt?.url || alt.title === this.lastTrack.title) return null
        track = alt
      }
      return track?.url ? track : null
    } catch {
      return null
    }
  }

  /** 换一首实在找不到同类型时，可退回的「其它风格」池（风格电台，与当前歌手无关也能播）。 */
  private static readonly FALLBACK_GENRES = ['轻音乐', '流行', '电子', '爵士', '民谣', '古典']

  /**
   * 换一首找不到同类型的其它歌时：从风格池里随机挑一个，直接播一首不同风格的歌并口播一句。
   * 兜底保证「换一首」永远有去处（不静默、也不追问），用户想指定仍可说「放首XX」。
   */
  private async playOtherType(): Promise<void> {
    const source = this.musicSource
    if (!source) return
    const genre =
      VoiceSessionService.FALLBACK_GENRES[
        Math.floor(Math.random() * VoiceSessionService.FALLBACK_GENRES.length)
      ]
    try {
      const track = source.resolve ? await source.resolve(genre) : null
      if (!track?.url) return
      // 退回风格电台后不再绑死原歌手，后续「换一首」走电台换台而非继续找原歌手
      await this.playTrack(track, messages(this.lang).music.switchedOther())
      this.musicActive = true
    } catch {
      // 实在不行就静默，不再递归追问
    }
  }

  /** 用户上一句「换一首」没找到同类型、正在等确认：这句是不是同意换其它风格？ */
  private shouldAcceptOtherType(text: string): boolean {
    // 再次说「换一首 / 来首其它的」这类没指定新偏好的换歌指令 = 同意换其它；
    // 「换首刘德华的」带了具体偏好，应交回正常流程去放刘德华，不强行换风格。
    if (detectMusicCommand(text) === 'next') return !nextPreference(text)
    const t = (text ?? '').trim()
    return /^(好|可以|行|嗯|要|就换|好的|好的呀|没问题|同意|是|对|换成|换个|换一个|再来一个|别的|其它|其他|换首其它的|来首其它的|来个其它的)$/.test(
      t
    )
  }

  /** 客户端点「换一首 / 换个风格」：解析下一首并下发 media.play；无音乐源或解析失败则静默忽略。 */
  private async nextMusic(genre?: string): Promise<void> {
    const source = this.musicSource
    if (!source) return
    const m = messages(this.lang).music
    // 没指定新风格/歌手时，用当前歌手重新搜该歌手的其它作品，而不是拿「歌手+歌名」原关键词
    // 再搜——后者常只命中同一首（不同视频但同名），用户看到歌名没变会以为没换。
    const query = genre || this.lastTrack?.artist || undefined
    const track = await this.nextTrack(query)
    if (!track) {
      // 换一首实在找不到同类型的其它歌（如动画片主题曲只有一首）：不直接乱播、也不静默无响应，
      // 反问用户、把选择权交给用户——用助手正常语音问要不要换其它风格（或直接点名想听的）。
      this.pendingNextFallback = true
      await this.speakReply(m.offerOtherType())
      return
    }
    // 换一首时歌手通常不变（同歌手下一首），沿用上一首歌手，保持点歌上下文
    this.lastTrack = {
      url: track.url,
      title: track.title,
      channel: track.channel,
      artist: this.lastTrack?.artist,
    }
    this.musicActive = true
    // 音量以默认值为起点：每次新播放下发 media.volume，供后续「调大/调小」相对增减。
    this.musicVolume = this.defaultVolume
    this.deps.send({ type: 'media.volume', volume: this.defaultVolume })
    // 默认循环次数带入：仅当「自动循环播放」开启时换歌也默认循环，>1 才下发 loop。
    this.deps.send({
      type: 'media.play',
      url: track.url,
      title: track.title,
      channel: track.channel,
      proxy: needsProxy(track.channel, track.url),
      ...(this.autoLoop && this.defaultLoop > 1 ? { loop: this.defaultLoop } : {}),
    })
    // 自动字幕：开关开启时，「换一首」同样是一次播放，同源尽力拉取字幕下发，与 playTrack 一致。
    void this.emitAutoSubtitle(track.title, this.lastTrack?.artist)
  }

  /**
   * 执行已识别的音乐控制指令（绕开 LLM）：解析并下发 media.play，口播一句确认。
   * 只负责动作本身；asr.final 由 finalizeUtterance 统一下发，保证「我说」卡片显示这句。
   * 解析失败也只友好告知「没找到」，不报「操作失败」这类像系统故障的措辞。
   */
  /** 下发 media.play 并口播确认。 */
  private async playTrack(
    track: { url: string; title: string; channel?: string; cover?: string; artist?: string },
    confirm: string,
    loop?: number,
    artist?: string,
    reuseSubtitle = false,
    contentType?: string
  ): Promise<void> {
    // 记下当前曲目，供「循环播放」指令复用（不必重新检索就能把同一首再播 N 遍）；
    // 同时记下歌手与内容类型，供后续点歌/换内容按当前上下文走、措辞不一律当成「歌」。
    this.lastTrack = {
      url: track.url,
      title: track.title,
      channel: track.channel,
      cover: track.cover,
      // 优先用源抠出的真实歌手（歌曲宝详情页），没有再退回语音点歌时口述的歌手
      artist: track.artist ?? artist,
      contentType: contentType ?? this.lastTrack?.contentType,
    }
    // 音量以默认值为起点：每次新播放下发 media.volume，供后续「调大/调小」相对增减。
    this.musicVolume = this.defaultVolume
    this.deps.send({ type: 'media.volume', volume: this.defaultVolume })
    // 有效循环次数：语音「循环 N 遍」显式指定优先；否则仅当「自动循环播放」开启时用默认循环次数；>1 才下发 loop。
    const effectiveLoop =
      typeof loop === 'number' && loop > 1 ? loop : this.autoLoop ? this.defaultLoop : undefined
    this.deps.send({
      type: 'media.play',
      url: track.url,
      title: track.title,
      channel: track.channel,
      proxy: needsProxy(track.channel, track.url),
      ...(effectiveLoop && effectiveLoop > 1 ? { loop: effectiveLoop } : {}),
      ...(track.cover ? { cover: track.cover } : {}),
    })
    // 自动字幕：开关开启时，播放这首歌后尽力同源拉取字幕并下发（无字幕则不显示，不弹面板）。
    void this.emitAutoSubtitle(track.title, artist, reuseSubtitle)
    await this.speakReply(confirm)
  }

  /**
   * 自动字幕：开关开启时，用当前音乐源拉取字幕并下发 media.subtitle。
   * 尽力而为——拉取失败/超时不影响播放；取不到时也下发空 lyrics，让客户端显示「暂无字幕」而非什么都不提示。
   */
  private async emitAutoSubtitle(title: string, artist?: string, reuse = false): Promise<boolean> {
    if (!this.autoSubtitle) {
      this.subtitleActive = false
      return false
    }
    // 循环播放重播同一首：直接复用上一次成功下发的同源字幕，不再重新拉取。
    // 否则缓存未命中 / 网络波动时 getSubtitle 返回 null，会把客户端已显示的歌词覆盖成「暂无字幕」。
    if (reuse && this.lastSubtitleLines) {
      this.deps.send({ type: 'media.subtitle', title, artist, lines: this.lastSubtitleLines })
      this.subtitleActive = this.lastSubtitleLines.length > 0
      return this.subtitleActive
    }
    const source = this.musicSource
    if (!source?.getSubtitle) {
      this.subtitleActive = false
      return false
    }
    try {
      const lines = await source.getSubtitle(artist ?? '', title)
      this.lastSubtitleLines = lines ?? []
      this.deps.send({ type: 'media.subtitle', title, artist, lines: lines ?? [] })
      this.subtitleActive = (lines ?? []).length > 0
      return this.subtitleActive
    } catch {
      this.lastSubtitleLines = null
      this.subtitleActive = false
      // 字幕失败不影响播放
      return false
    }
  }

  /**
   * 只给了歌手/歌名：用 MusicBrainz 检索候选。
   * 多于 1 首 → 口播编号列表并挂起待选；正好 1 首 → 直接播；0 首 → 交回调用方按原逻辑处理。
   * 返回 true 表示本次已处理（列表已给或已播），调用方不必再 resolve。
   */
  /**
   * 点歌信息不足时给候选列表让用户选；forceList（推荐意图）时即使只有 1 首也只列不给播，
   * 且没具体歌手/风格时不擅自乱播、改口播引导，保证「推荐」永远只出选项不直接播放。
   * 多于 1 首 → 口播编号列表并挂起待选；正好 1 首且非强制列表 → 直接播；0 首 → 交回调用方。
   * 返回 true 表示本次已处理（列表已给或已播），调用方不必再 resolve。
   */
  /**
   * 点歌信息不足时给候选列表让用户选。
   * @param forceList 即使检索到 1 首也只列不给播（推荐意图 / 按歌手浏览，绝不替用户直接播放）
   * @param recommend 列表话术用「为你推荐」而非「找到几首」（推荐意图时用）
   * @param allowContext 是否允许「按当前歌手优先」自动选同歌手版本；带「再」的请求关掉它
   */
  private async offerCandidates(
    text: string,
    forceList = false,
    recommend = false,
    allowContext = true
  ): Promise<boolean> {
    const genre = genreToKeyword(text)
    if (!needsCandidateList(genre) && !forceList) return false
    const query = candidateQuery(genre)
    const m = messages(this.lang).music
    if (!query) {
      // 推荐/浏览但没具体歌手/风格：引导用户补充，绝不自动播放
      if (forceList) {
        await this.speakReply(m.recommendPrompt())
        return true
      }
      return false
    }
    const items = await searchCandidates(query, this.deps.candidateFetcher)
    if (items.length === 0) {
      // 信息不足（只说了歌手/歌名）却搜不到：友好告知「没找到」，绝不退化成
      // 「直接播一个裸歌手名」乱播（那样既没问用户、又可能播错版本）。
      if (forceList || needsCandidateList(genre)) {
        await this.speakReply(m.notFound(isSpokenContentRequest(text)))
        return true
      }
      return false
    }
    if (items.length === 1 && !forceList) {
      await this.playChosen(items[0], query)
      return true
    }
    // 多候选：仅当正处于某个歌手的播放会话（musicActive）时，才优先挑同歌手的版本，
    // 避免「正在听周杰伦、点七里香却让我选」；已停止则老老实实列选项。
    // 仅当列表被「真正收窄」（过滤掉非同歌手候选）才直接播第一首；否则（含全部同歌手、
    // 或都没匹配）照旧列出来让用户选，不替用户做主。
    // 强制列表（推荐/按歌手浏览）一律不收窄、不自动播放，直接列出来。
    const ranked = !forceList
      ? filterByCurrentArtist(items, allowContext && this.musicActive ? this.lastTrack?.artist : undefined)
      : items
    if (ranked.length < items.length) {
      await this.playChosen(ranked[0], query)
      return true
    }
    this.pendingCandidates = { items: ranked, query }
    const labels = items.map((c) => (c.artist ? `${c.title}，${c.artist}` : c.title))
    await this.speakReply(
      (recommend ? m.recommend(labels) : m.candidates(labels)) + m.chooseHint()
    )
    return true
  }

  /** 用「用户核心词 + 选中歌名」拼成歌手+歌名去抽音轨，接上严格匹配，避免乱播。 */
  private async playChosen(chosen: MusicCandidate, query: string): Promise<void> {
    const source = this.musicSource
    const m = messages(this.lang).music
    if (!source) {
      await this.speakReply(m.notFound(isSpokenContentRequest(query)))
      return
    }
    const keyword = query && query !== chosen.title ? `${query} ${chosen.title}` : chosen.title
    try {
      const track = await source.resolve(keyword)
      if (!track?.url) throw new Error('no track')
      await this.playTrack(track, m.playing(track.title), undefined, chosen.artist)
    } catch (e) {
      // 占位播放源尚未实现：明确告知用户该源不可用，引导改用百度搜索，
      // 绝不把「未实现」伪装成「没找到这首歌」误导用户。
      if (e instanceof MusicSourceNotImplementedError) {
        await this.speakReply(m.notImplemented(e.sourceKind))
        return
      }
      await this.speakReply(m.notFound(isSpokenContentRequest(keyword)))
    }
  }

  /**
   * 处理用户对待选列表的语音选择。返回 true 表示这句已被当作选择消费。
   * 必须在回声比对之前调用：用户说的「第二首」「稻香」正是刚口播过的词，
   * 否则会被 resemblesSpoken 当回声丢掉。
   */
  private async handleCandidateSelection(text: string): Promise<boolean> {
    const pending = this.pendingCandidates
    if (!pending) return false
    const idx = parseSelection(text, pending.items)
    if (idx === null) {
      // 不是选择（可能用户换了话题）：清掉待选，交回常规流程处理这句
      this.pendingCandidates = null
      return false
    }
    this.pendingCandidates = null
    this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
    await this.playChosen(pending.items[idx], pending.query)
    return true
  }

  private async runMusicCommand(action: NonNullable<ReturnType<typeof detectMusicCommand>>, text: string): Promise<void> {
    const source = this.musicSource
    if (!source) return
    const genre = genreToKeyword(text)
    const m = messages(this.lang).music
    try {
      switch (action) {
        case 'recommend': {
          // 推荐：只给候选列表绝不自动播放，即使检索到 1 首也只列出来让用户选
          await this.offerCandidates(text, true, true)
          break
        }
        case 'play': {
          // 只说「周杰伦」「稻香」：先给候选列表让用户选。
          // 「周杰伦的歌 / 刘德华歌曲」是按歌手浏览，强制列清单、绝不自动播放；
          // 「放一首稻香」靠当前歌手上下文自动选同歌手版本，不强制列表。
          // 带「再」的请求（再放稻香…）关掉上下文，不当成「还是当前歌手的歌」直接播。
          if (await this.offerCandidates(text, isArtistBrowse(text), false, !hasAgainMarker(text))) break
          const track = await source.resolve(genre)
          if (!track?.url) throw new Error('no track')
          // 「循环 N 遍」可作为点歌后缀（如「放稻香循环3遍」），一并下发给客户端循环
          const loop = parseLoopCount(text)
          // 关键词带了歌手（如「周杰伦 稻香」）→ 记下歌手，供后续点歌按当前歌手优先
          const words = contentWords(genre)
          const artistGuess = words.length >= 2 ? words[0] : this.lastTrack?.artist
          await this.playTrack(
            track,
            m.playing(track.title),
            loop > 1 ? loop : undefined,
            artistGuess,
            false,
            detectContentType(text) ?? detectContentType(track.title)
          )
          this.musicActive = true
          break
        }
        case 'next': {
          // 没指定新歌手/风格（纯粹「换一首」）：用当前歌手重新搜该歌手的其它作品，
          // 给出不同歌名的另一首，而不是拿「歌手+歌名」原关键词再搜（后者常只命中同名的同一首）；
          // 明确说了新歌手/风格（「换首刘德华的」）才切到新偏好。
          const req = nextPreference(text) || this.lastTrack?.artist || undefined
          const track = await this.nextTrack(req)
          if (!track) {
            // 没找到同类型的其它歌：把选择权交给用户——问要不要换其它风格（或直接点名），由用户确认
            this.pendingNextFallback = true
            await this.speakReply(m.offerOtherType())
            break
          }
          await this.playTrack(
            track,
            m.switched(track.title),
            undefined,
            undefined,
            false,
            detectContentType(track.title) ?? this.lastTrack?.contentType
          )
          this.musicActive = true
          break
        }
        case 'loop': {
          // 循环播放：把最近一次下发的曲目按指定遍数重播（不重新检索）。
          // 没指定遍数时用「默认循环次数」（即设置里的 defaultLoop）；没在播的曲子则友好提示。
          if (!this.lastTrack) {
            await this.speakReply(m.loopNothing())
            break
          }
          const explicitLoop = parseLoopCount(text)
          const loop = explicitLoop > 1 ? explicitLoop : this.defaultLoop
          await this.playTrack(this.lastTrack, m.looping(loop), loop > 1 ? loop : undefined, this.lastTrack.artist, true)
          this.musicActive = true
          break
        }
        case 'pause':
          // 没在播放却说「暂停」是谎话：如实说当前没有可暂停的内容。
          if (!this.musicActive) {
            await this.speakReply(m.musicNotPlaying())
            break
          }
          this.deps.send({ type: 'media.pause' })
          await this.speakReply(m.paused())
          break
        case 'resume':
          if (!this.musicActive) {
            await this.speakReply(m.musicNotPlaying())
            break
          }
          this.deps.send({ type: 'media.resume' })
          await this.speakReply(m.resumed())
          break
        case 'stop':
          if (!this.musicActive) {
            await this.speakReply(m.musicNotPlaying())
            break
          }
          this.deps.send({ type: 'media.stop' })
          this.musicActive = false
          this.subtitleActive = false
          await this.speakReply(m.stopped())
          break
      }
    } catch (e) {
      // 占位播放源尚未实现：明确告知用户该源不可用，引导改用百度搜索
      if (e instanceof MusicSourceNotImplementedError) {
        await this.speakReply(m.notImplemented(e.sourceKind))
        return
      }
      // 当前播的是评书/戏曲等非歌曲内容时，即使这句指令里没带类型词也不能说「没找到这首歌」
      await this.speakReply(m.notFound(isSpokenContentRequest(text) || !!this.lastTrack?.contentType))
    }
  }

  /**
   * 音乐/音量/记忆等「意图明确」的指令直连拦截，确定性落地、绕开大模型。
   * 复用于两处：
   *  - finalizeUtterance 的空闲实时定稿；
   *  - runTurn 里排队句的回放（否则排队句会被丢给大模型，由 play_music 自动播放，
   *    破坏「按歌手浏览要给候选列表让用户选」的直连行为）。
   * 调用方负责保证「不在播报中」（playbackPending=false）并自行下发 asr.final；
   * 不在此处再判 playbackPending/processing——回放时 processing 仍为 true 属正常。
   * 返回 true 表示已被直连命令消费。
   */
  private async handleDirectCommand(text: string): Promise<boolean> {
    const memCmd = detectMemoryCommand(text)
    if (memCmd && this.deviceId) {
      await this.runMemoryCommand(memCmd)
      return true
    }
    const volCmd = detectVolumeCommand(text)
    if (volCmd) {
      await this.runVolumeCommand(volCmd)
      return true
    }
    const subCmd = detectSubtitleCommand(text)
    if (subCmd) {
      await this.runSubtitleCommand(subCmd)
      return true
    }
    // 「切换播放模式」「换个播放模式」含「播放」，会被音乐指令的 play 词误中，
    // 故播放模式检测必须排在音乐指令之前。
    const playModeCmd = detectPlayModeCommand(text)
    if (playModeCmd) {
      await this.runPlayModeCommand(playModeCmd)
      return true
    }
    const action = detectMusicCommand(text)
    const effectiveAction: NonNullable<ReturnType<typeof detectMusicCommand>> | null =
      action ?? (this.musicSource && looksLikeBareMusicQuery(text) ? 'play' : null)
    if (effectiveAction && this.musicSource) {
      await this.runMusicCommand(effectiveAction, text)
      return true
    }
    // 商品/好价查询放最后：不抢记忆/音量/字幕/播放模式/音乐等既有直连命令。
    // 高置信泛查询（有什么折扣、便宜的东西、查询商品…）绕开 LLM 直接查；
    // 单独「东西/商品/买卖」等泛词不在此拦，交给 LLM 结合上下文判断，避免误触发。
    if (detectDealsCommand(text)) {
      await this.runDealsCommand()
      return true
    }
    return false
  }

  /**
   * 处理「查商品 / 找好价」直接指令（绕开 LLM）：直接调 dealsTool 拿本地化文本并播报。
   * 工具内部对抓取失败 / 空结果已有本地化兜底文案（含「暂时查不到」），这里不改写、不编造，
   * 保证「没有好价」时也如实播报；dealsQuery 可由测试注入桩，避免联网。
   */
  private async runDealsCommand(): Promise<void> {
    const query =
      this.deps.dealsQuery ??
      (async (): Promise<string> => {
        // DealsOptions.source 必需（数据源由调用方注入，工具本身不绑定站点），
        // 这里用默认 smzdm 源；组合根若已注入 dealsQuery 则走注入的那个。
        const tool = createDealsTool(this.lang, { source: createSmzdmSource() })
        return tool.call({})
      })
    try {
      const text = await query()
      await this.speakReply(text?.trim() || formatDeals(this.lang, []))
    } catch {
      await this.speakReply(formatDeals(this.lang, []))
    }
  }

  /**
   * 处理音量控制指令（绕开 LLM）：set 设到绝对值、increase/decrease 在当前值上 ±10%，
   * 下发 media.volume 让客户端真正调音量，并口播确认（含当前百分比）。
   * 已到最大/最小时再让调大/调小，提示「已经最大/最小了」而非静默或重复确认。
   * 音量状态由网关持有，随客户端滑块回执（music.volume）同步，保证相对增减准确。
   */
  private async runVolumeCommand(cmd: NonNullable<ReturnType<typeof detectVolumeCommand>>): Promise<void> {
    const m = messages(this.lang).music
    const step = 0.1
    if (cmd.kind === 'increase') {
      if (this.musicVolume >= 1 - 1e-6) {
        await this.speakReply(m.volumeMax())
        return
      }
      const next = Math.min(1, this.musicVolume + step)
      this.musicVolume = next
      this.deps.send({ type: 'media.volume', volume: next })
      await this.speakReply(m.volumeUp(Math.round(next * 100)))
      return
    }
    if (cmd.kind === 'decrease') {
      if (this.musicVolume <= 1e-6) {
        await this.speakReply(m.volumeMin())
        return
      }
      const next = Math.max(0, this.musicVolume - step)
      this.musicVolume = next
      this.deps.send({ type: 'media.volume', volume: next })
      await this.speakReply(m.volumeDown(Math.round(next * 100)))
      return
    }
    // set：设到绝对值（超出范围收敛到 0–1）
    const next = Math.min(1, Math.max(0, cmd.value))
    this.musicVolume = next
    this.deps.send({ type: 'media.volume', volume: next })
    await this.speakReply(m.volumeSet(Math.round(next * 100)))
  }

  /** 处理「忘了XX / 清空记忆」直接指令：落地删除并口播确认，不进 LLM。 */
  private async runMemoryCommand(cmd: ReturnType<typeof detectMemoryCommand>): Promise<void> {
    if (!cmd || !this.deviceId) return
    const m = messages(this.lang).memory
    if (cmd.action === 'remember') {
      await this.deps.data.saveMemory(this.deviceId, cmd.key, cmd.value)
      await this.speakReply(m.remembered(cmd.key, cmd.value))
      return
    }
    if (cmd.action === 'clear') {
      await this.deps.data.forgetMemory(this.deviceId)
      await this.speakReply(m.cleared())
      return
    }
    const n = await this.deps.data.forgetMemory(this.deviceId, cmd.topic)
    await this.speakReply(n > 0 ? m.forgot(cmd.topic, n) : m.nothingToForget())
  }

  /**
   * 处理「关闭字幕 / 开启字幕」直接指令（绕开 LLM）：运行时切换 autoSubtitle 开关，
   * 关闭时下发 close 事件收起当前字幕面板，开启时对正在播放的曲子重发字幕。
   * 只影响本会话，持久设置仍由设置页的开关控制。
   */
  private async runSubtitleCommand(action: NonNullable<ReturnType<typeof detectSubtitleCommand>>): Promise<void> {
    const m = messages(this.lang).music
    this.autoSubtitle = action === 'on'
    if (action === 'off') {
      // 如实反馈：当前本就没有字幕时，不乱称「已关闭」，直接说没有。
      const had = this.subtitleActive
      this.deps.send({ type: 'media.subtitle', title: '', lines: [], close: true })
      this.subtitleActive = false
      await this.speakReply(had ? m.subtitleOff() : m.subtitleNoActive())
      return
    }
    // 开启：对当前正在播放的曲子重发字幕；没有则在下一首播放时自动带出。
    if (this.lastTrack) {
      // 如实反馈：有字幕才说「已开启字幕」，没有就直说这首歌没字幕，不乱称已显示。
      const has = await this.emitAutoSubtitle(this.lastTrack.title, this.lastTrack.artist)
      await this.speakReply(has ? m.subtitleOn() : m.subtitleNone())
      return
    }
    // 没在播的曲子：仅把开关打开（设置态），当前没有字幕可显示，照实说已开启即可。
    this.subtitleActive = false
    await this.speakReply(m.subtitleOn())
    await this.speakReply(m.subtitleOn())
  }

  /**
   * 处理「切换播放模式」直接指令（绕开 LLM）：下发 client.playMode 让客户端
   * 在「悬浮小圆」与「普通播放条」之间切换，再口播一句确认。
   * toggle 不指定 mode，由客户端翻转当前模式；float/player 则直接指定。
   */
  private async runPlayModeCommand(action: NonNullable<ReturnType<typeof detectPlayModeCommand>>): Promise<void> {
    const m = messages(this.lang).music
    const mode = action === 'float' ? 'float' : action === 'player' ? 'player' : undefined
    this.deps.send({ type: 'client.playMode', ...(mode ? { mode } : {}) })
    const confirm =
      action === 'float' ? m.playModeFloat() : action === 'player' ? m.playModePlayer() : m.playModeToggled()
    await this.speakReply(confirm)
  }

  /** 口播一句短确认：复用 TTS 下发链路（tts.start → 流式 → tts.end），不进 LLM。 */
  private async speakReply(text: string): Promise<void> {
    const turn = ++this.turn
    this.cancelled = false
    this.spoken.length = 0
    this.downlinkBytes = 0
    const playback = this.armPlaybackWait()
    this.speaking = true
    this.playbackPending = true
    this.deps.send({ type: 'tts.start', format: 'pcm16', sampleRate: 24000 })
    this.deps.send({ type: 'llm.delta', text })
    this.deps.send({ type: 'llm.done' })
    await this.speakSentence(text, turn)
    if (this.turn === turn && !this.cancelled) {
      this.speaking = false
      this.deps.send({ type: 'tts.end' })
    }
    this.tightenPlaybackTimeout()
    await playback
  }

  /** 供位置类工具实时读取会话最近一次上报的设备位置。 */
  getLocation(): LocationInfo | null {
    return this.location
  }

  /**
   * 懒加载定位：位置/天气工具被调用但本会话尚无位置时由工具回调。
   * 下发 client.location.request 让客户端请求授权并上报 session.location，
   * 等到上报（或超时）后兑现 promise；已在途则不重复下发。
   * 用户从不问位置相关问题时，会话全程不触碰定位，避免冷启动弹窗。
   */
  private requestClientLocation(): Promise<LocationInfo | null> {
    if (this.location) return Promise.resolve(this.location)
    return new Promise((resolve) => {
      this.pendingLocation.push(resolve)
      if (this.locationRequestSent) return
      this.locationRequestSent = true
      this.deps.send({ type: 'client.location.request' })
      // 客户端取不到/拒绝授权/离线：超时兑现为 null，工具回退到「位置不可用」话术
      const timeoutMs = this.deps.locationRequestTimeoutMs ?? 8000
      this.locationRequestTimer = setTimeout(() => {
        this.locationRequestTimer = null
        this.resolvePendingLocation()
      }, timeoutMs)
    })
  }

  /** 位置上报到达后兑现所有挂起请求；超时也走这里（location 可能仍为空）。 */
  private resolvePendingLocation(): void {
    if (this.locationRequestTimer) {
      clearTimeout(this.locationRequestTimer)
      this.locationRequestTimer = null
    }
    this.locationRequestSent = false
    const resolvers = this.pendingLocation
    this.pendingLocation = []
    for (const r of resolvers) r(this.location)
  }

  handleBinary(chunk: Uint8Array): void {
    if (!this.active) return
    // 帧一直会来，顺手把到期的回声抑制恢复掉
    if (this.halfDuplex && !this.echo.muted()) this.syncDuplex()
    const vad = this.vad.push(chunk, { strict: false })
    for (const frame of vad.frames) {
      void this.asr.push(frame).then((partial) => {
        // 播报期间只做唤醒词识别（用定稿），实时草稿不上发给客户端，避免回声刷屏
        if (partial && !this.playbackPending) {
          this.deps.send({ type: 'asr.partial', text: partial })
        }
      })
    }
    // 只有真正的人声帧才重置句末计时：静音帧持续到达也会让计时器自然到期
    if (vad.voiced) this.armEndpoint()
  }

  /** 半双工状态只在切换时下发一次，避免每帧都刷事件。 */
  private syncDuplex(): void {
    const half = this.echo.muted()
    if (half === this.halfDuplex) return
    this.halfDuplex = half
    this.deps.send({ type: 'audio.duplex', mode: half ? 'half' : 'full' })
  }

  private armEndpoint(): void {
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.endpointTimer = setTimeout(() => {
      // 串行而非丢弃：上一句还没交给大模型时，下一句也必须在链里排队等
      this.finalizeChain = this.finalizeChain
        .then(() => this.finalizeUtterance())
        .catch(() => undefined)
    }, this.deps.asrEndpointMs)
  }

  private async finalizeUtterance(): Promise<void> {
    // 打断/关闭后串行链里可能还挂着定稿，不能让它再发 asr.final 或排队
    if (!this.active || this.cancelled) return
    // 只有确认用户说完了（静音够久）才定稿；中间结果从不触发回复
    const text = await this.asr.finalize()
    if (!this.active || this.cancelled) return
    // 环境杂音被 ASR 误识别出的伪文本、以及播报被收回的回声，都静默丢弃，
    // 不进模型也不进队列，避免凭空多出一轮回答和 TTS
    if (!text || isNoise(text)) return

    // 上一轮给过候选歌曲列表，这一句优先当作「选第几首 / 说歌名」解析。
    // 必须在下面的回声比对之前：用户说的「第二首」「稻香」正是刚口播过的词，
    // 否则会被 resemblesSpoken 当成播报回声丢掉，导致永远选不中。
    if (this.pendingCandidates && await this.handleCandidateSelection(text)) return

    // 上一轮「换一首」没找到同类型的其它歌，正等用户确认是否换其它风格：
    // 把决定权交还给用户。这句优先判定为「接受换其它 / 点名想听什么」。
    if (this.pendingNextFallback) {
      this.pendingNextFallback = false
      // 用户同意换其它风格（好/换其他的/来首其它的…）→ 直接播一首不同风格的并口播一句。
      if (this.shouldAcceptOtherType(text)) {
        this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
        await this.playOtherType()
        return
      }
      // 用户没说「换其它的」：可能是点名想听的（放首XX / 换首刘德华的），或无关闲聊。
      // 不消费这句、也不替用户做主——清掉待确认标记后照常走下面的音乐/LLM 分支处理。
    }

    // 播报（TTS）进行中：不放行成新轮次，也不排队插话——其它声音一律忽略。
    // 但保留唤醒词识别：把识别结果回传客户端做「小熊小熊」比对，
    // 只有命中唤醒词才允许打断，否则播报完整播完。
    // 助手自己刚念过的原话（回声）直接丢弃，且此分支不触发回声兜底静音，
    // 否则会连用户想用来打断的唤醒词一起掐掉。
    if (this.playbackPending) {
      if (Date.now() < this.echoUntil && resemblesSpoken(text, this.spoken)) return
      this.deps.send({ type: 'asr.final', text, queueRemaining: 0 })
      return
    }
    // 文本级回声兜底：刚播完的尾巴里仍可能混进助手说过的原话（含复述用户），
    // 播放结束后的保护窗口内按回声丢弃，避免被当成用户新的一句。
    if (Date.now() < this.echoUntil && resemblesSpoken(text, this.spoken)) {
      this.echo.noteBargeIn()
      this.syncDuplex()
      return
    }

    // 唤醒模式只回识别结果给客户端做唤醒词匹配，不进入 LLM/TTS
    if (this.mode === 'wake') {
      this.deps.send({ type: 'asr.final', text, queueRemaining: 0 })
      return
    }

    // 当前轮还没跑完（未播完/未在应答）：不打断、不消费，仅把这句排进队列；
    // 排队句会在本轮播完后由 runTurn 回放，并同样走下面的直连拦截，
    // 避免被丢给大模型由 play_music 自动播放（破坏「按歌手浏览要给候选列表让用户选」）。
    if (this.processing) {
      if (this.queue.length >= MAX_QUEUE) {
        this.deps.send({
          type: 'asr.rejected',
          text,
          reason: 'queue-full',
          message: messages(this.lang).queue.full(),
        })
        return
      }
      this.queue.push(text)
      this.deps.send({
        type: 'asr.queued',
        text,
        position: this.queue.length,
        size: MAX_QUEUE,
        message: messages(this.lang).queue.accepted(this.queue.length, MAX_QUEUE),
      })
      return
    }

    // 空闲：音乐/音量/记忆等意图明确的指令直连拦截，确定性落地，绕开大模型
    // （避免模型幻觉「说播放却没播放 / 说调音量却没调」）。没有音乐源时不拦截音乐类。
    // 这里统一下发一次 asr.final（「我说」卡片数据源），命中命令则由拦截内部消费，
    // 未命中则继续交给大模型正常应答。
    this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
    if (await this.handleDirectCommand(text)) return

    void this.runTurn(text)
  }

  /**
   * 串行跑完一整条链：当前回答 → 等客户端播完 → 队首插话 → …
   * processing 在整条链（含等播完）结束前一直为 true，中途定稿的句子只会进队列。
   * 这样既不会两轮 turn 号互相踩踏，也保证下一句的识别内容要等播完才显示。
   */
  private async runTurn(text: string): Promise<void> {
    if (this.processing) return
    this.processing = true
    // 整条链共用一个 turn：串行执行，不存在两轮互相踩踏。
    // cancel / start 会 ++turn，链据此自行退出。
    const turn = ++this.turn
    this.cancelled = false
    try {
      let current: string | undefined = text
      while (current !== undefined) {
        // 每一句的播报内容与上一句无关，清空回声比对样本
        this.spoken.length = 0
        this.downlinkBytes = 0
        // 先建好等待再开播：客户端可能在音频下发完之前就回执播完
        const playback = this.armPlaybackWait()
        let ttsStarted = false
        let directHandled = false
        try {
          this.deps.data.insertCommandLog(this.deviceId, current, 'pending')
          // 排队回放的句子也要走直连拦截（音乐/音量/记忆），不能丢给大模型自动播放；
          // 首句已由 finalizeUtterance 拦过，这里再拦一次是幂等的（非指令会返回 false）。
          directHandled = await this.handleDirectCommand(current)
          if (!directHandled) ttsStarted = await this.runAgent(current, turn)
        } catch (err) {
          this.sendError('LLM_ERROR', (err as Error).message)
        }
        if (this.turn !== turn || this.cancelled) break
        // 必须等这一句真正播完，才轮到下一句：否则会掐掉尾音、
        // 也会让「你说」提前跳到下一句识别内容。
        if (ttsStarted || directHandled) {
          this.tightenPlaybackTimeout()
          await playback
        } else this.cancelPlaybackWait()
        if (this.turn !== turn || this.cancelled) break
        const next = this.queue.shift()
        if (!next) break
        // 让客户端把界面切到这句，并同步权威剩余数（客户端不靠 ±1 猜测）
        this.deps.send({ type: 'asr.final', text: next, queueRemaining: this.queue.length })
        current = next
      }
    } finally {
      this.processing = false
    }
  }

  /** 先建好「等播完」的 Promise，再开始下发，避免回执早于等待而丢失。 */
  private armPlaybackWait(): Promise<void> {
    this.cancelPlaybackWait()
    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.playbackTimer) clearTimeout(this.playbackTimer)
        this.playbackTimer = null
        this.playbackResolve = null
        // 播完（或超时）后关闭回声门控窗口
        this.playbackPending = false
        resolve()
      }
      this.playbackResolve = done
      // 用固定上限兜底，客户端没回执也不会把队列卡死；
      // 下发完音频后会按实际时长收紧。
      this.playbackTimer = setTimeout(done, 30_000)
    })
  }

  /** 音频下发完后按实际时长收紧超时，避免客户端断线时白等 30 秒。 */
  private tightenPlaybackTimeout(): void {
    const resolve = this.playbackResolve
    if (!resolve) return
    if (this.playbackTimer) clearTimeout(this.playbackTimer)
    // 24kHz/16bit/mono = 48000 字节/秒，再留 1.5 秒余量
    const estimatedMs = (this.downlinkBytes / 48000) * 1000 + 1500
    this.playbackTimer = setTimeout(resolve, Math.max(2000, estimatedMs))
  }

  private cancelPlaybackWait(): void {
    if (this.playbackTimer) clearTimeout(this.playbackTimer)
    this.playbackTimer = null
    // 让正在 await 的链立刻解除阻塞，链随后会检查 cancelled 自行退出
    this.playbackResolve?.()
    this.playbackResolve = null
  }

  private resolvePlayback(): void {
    this.playbackResolve?.()
  }

  /**
   * 边生成边合成：LLM 流式出字，遇到句末标点就把这句立刻交给 TTS，
   * 让首声在 LLM 还没生成完时就响，显著降低语音延迟。
   * turn 用于识别「这一轮已被打断」：旧轮的所有下发都要停。
   */
  /** @returns 是否发出过 tts.start（决定要不要等播放完成回执） */
  private async runAgent(text: string, turn: number): Promise<boolean> {
    if (!this.agent) return false
    const stale = () => this.turn !== turn || this.cancelled
    let buffer = ''
    let ttsStarted = false
    let ttsChain: Promise<void> = Promise.resolve()
    const enqueue = (sentence: string) => {
      // 特殊符号/markdown/emoji 只留在界面，不送进 TTS 念出来
      const clean = sanitizeForSpeech(sentence)
      if (!clean) return
      if (!ttsStarted) {
        ttsStarted = true
        this.speaking = true
        // 从宣布播报起就进入「播放中」窗口，直到客户端回执播完
        this.playbackPending = true
        this.deps.send({ type: 'tts.start', format: 'pcm16', sampleRate: 24000 })
      }
      ttsChain = ttsChain.then(() => this.speakSentence(clean, turn))
    }
    try {
      const full = await this.agent.reply(
        text,
        (delta) => {
          if (stale()) return
          this.deps.send({ type: 'llm.delta', text: delta })
          buffer += delta
          let cut = sentenceCut(buffer)
          while (cut > 0) {
            enqueue(buffer.slice(0, cut))
            buffer = buffer.slice(cut)
            cut = sentenceCut(buffer)
          }
        },
        (delta) => {
          // 思考过程只给界面看，不进 buffer、不进 TTS
          if (stale()) return
          this.deps.send({ type: 'llm.thinking', text: delta })
        }
      )
      if (stale()) {
        this.deps.data.insertCommandLog(this.deviceId, text, 'cancelled')
        return ttsStarted
      }
      enqueue(buffer)
      buffer = ''
      this.deps.send({ type: 'llm.done' })
      this.deps.data.insertCommandLog(this.deviceId, text, full.slice(0, 200))
      await ttsChain
      if (ttsStarted && !stale()) {
        this.speaking = false
        this.deps.send({ type: 'tts.end' })
      } else if (!ttsStarted && !stale()) {
        // 整句都不可念（大模型泄漏的控制符 / 空回复 / 只剩符号）：绝不当作正文念出来，
        // 给一句兜底口播，让人能自然重说一遍。
        await this.speakReply(messages(this.lang).llmFallthrough())
      }
      return ttsStarted
    } catch (err) {
      if (stale()) return ttsStarted
      this.sendError('LLM_ERROR', (err as Error).message)
      return ttsStarted
    }
  }

  private async speakSentence(sentence: string, turn: number): Promise<void> {
    if (this.turn !== turn || this.cancelled) return
    this.spoken.push(sentence)
    // 只留最近几句：回声延迟有限，太久以前的文本不该再参与比对
    if (this.spoken.length > 6) this.spoken.shift()
    for await (const frame of this.tts.synthesize(sentence)) {
      if (this.turn !== turn || this.cancelled) return
      this.downlinkBytes += frame.byteLength
      this.echo.onDownlink()
      // 每下发一帧就把回声保护窗口往后挪：窗口始终盖住「最后一帧之后的一小段余音」
      this.echoUntil = Date.now() + 1200
      this.deps.sendAudio(frame)
    }
  }

  /**
   * 会话建连时一次性探测 ASR/TTS/LLM 就绪状态；任一未就绪就下发预录提示音，
   * 让用户「听得见地」知道能力缺失（此时网关还没法用语音播报，只能靠提示音）。
   * 探测走 /api/health 的同一套带缓存逻辑（15s 缓存），重连/重唤醒都便宜，不每次真打服务。
   * 与客户端 health watch 互补：watch 负责「运行中 ok→down」的瞬时变化，这里负责
   * 「建连那一刻就已不可用」的兜底——这种情形 watch 的 prev 为空、不会触发，容易静默失效。
   */
  private async announceCapabilityProblems(): Promise<void> {
    let report: import('./health').HealthReport | null = null
    try {
      report = this.deps.capabilityProbe
        ? await this.deps.capabilityProbe()
        : this.deps.config
          ? await buildHealth(this.deps.config, this.lastVoice)
          : null
    } catch {
      return
    }
    if (!report) return
    const down: Array<'asr-down' | 'tts-down' | 'llm-down' | 'network-down'> = []
    if (!report.asr.reachable) down.push('asr-down')
    if (!report.tts.reachable) down.push('tts-down')
    if (!report.llm.reachable) down.push('llm-down')
    if (!report.network.reachable) down.push('network-down')
    for (const cue of down) this.deps.send({ type: 'client.cue', cue })
  }

  private async start(
    _sessionId: string,
    lang: Lang,
    timezone?: string,
    mode: 'wake' | 'dialog' = 'dialog',
    voice?: VoiceConfig
  ): Promise<void> {
    this.lang = lang
    // 用户没带时区或带的是非法值就退回东 8 区
    this.timezone = timezone?.trim() || 'Asia/Shanghai'
    this.mode = mode
    this.active = true
    this.lastVoice = voice
    // 按客户端设置展开三套能力配置并构建实例：地址 / 密钥 / 参数一律来自设置，
    // 不再读网关硬编码。每次 start 重建（重武装也重建，状态由 reset 清空，跨轮记忆不丢）。
    const resolved = this.deps.resolveVoice(voice)
    this.asr = this.deps.createAsr(resolved.asr)
    this.tts = this.deps.createTts(resolved.tts)
    // 新会话（或重武装）作废旧会话的在途回调与排队
    this.turn += 1
    this.cancelled = false
    this.processing = false
    this.speaking = false
    this.playbackPending = false
    this.echoUntil = 0
    this.queue.length = 0
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
    this.echo.release()
    this.syncDuplex()
    this.asr.reset()
    this.vad.reset()

    // 重新武装 vs 全新：agent 已存在即视为重武装。普通重唤醒/重连（来源未变）保留原 agent
    // （含本轮对话上下文，不丢）；仅当来源真的变了（如切到 DashScope）才重建 LLM 客户端，
    // 让「切换来源」立即生效，同时记忆已缓存直接复用、不丢长期记忆。
    const llmKey = JSON.stringify(resolved.llm)
    const rearm = this.agent !== null
    const llmChanged = this.lastLlmKey !== llmKey
    if (rearm && !llmChanged) {
      // 来源没变：保留原 agent（对话历史不丢），仅复位在途轮次与播放/回声状态。
      this.lastLlmKey = llmKey
      return
    }
    if (rearm) {
      // 来源变了：重建 agent（记忆已缓存复用，不丢长期记忆）；切来源本就发生在设置页、非对话中途，
      // 本轮对话历史随旧 agent 作废可接受。
      this.agent = mode === 'wake'
        ? null
        : this.deps.agentFactory(
            resolved.llm,
            lang,
            this.timezone,
            () => this.getLocation(),
            () => this.musicSource,
            (m) => this.deps.send(m),
            this.memoryStore,
            this.memoryContext,
            () => this.requestClientLocation(),
            this.autoSubtitle,
            this.defaultLoop,
            this.defaultVolume,
            this.autoLoop,
            () => (this.musicActive && this.lastTrack ? { title: this.lastTrack.title, artist: this.lastTrack.artist, contentType: this.lastTrack.contentType } : null),
          )
      this.lastLlmKey = llmKey
      return
    }

    // 全新会话：清空跨轮状态并重建 LLM
    this.pendingCandidates = null
    this.pendingNextFallback = false
    // 唤醒模式不需要 LLM，省掉一次模型实例构造
    // 加载该设备的长期记忆并注入系统提示（让助手「知道你的习惯」）；
    // memoryStore 同时交给工具层，供 remember/recall/forget 读写。无 deviceId 则无记忆。
    const memoryStore: MemoryStore | undefined = this.deviceId
      ? {
          save: (k, v) => this.deps.data.saveMemory(this.deviceId, k, v),
          list: () => this.deps.data.getMemories(this.deviceId),
          forget: (q) => this.deps.data.forgetMemory(this.deviceId, q),
        }
      : undefined
    const memoryContext = memoryStore
      ? messages(this.lang).memory.context(formatMemories(await this.deps.data.getMemories(this.deviceId)))
      : undefined
    // 缓存记忆相关引用，重武装时直接复用（记忆本就来自同一设备，无需重新拉取）。
    this.memoryStore = memoryStore
    this.memoryContext = memoryContext
    this.agent =
      mode === 'wake'
        ? null
        :                   this.deps.agentFactory(
            resolved.llm,
            lang,
            this.timezone,
            () => this.getLocation(),
            () => this.musicSource,
            (m) => this.deps.send(m),
            memoryStore,
            memoryContext,
            () => this.requestClientLocation(),
            this.autoSubtitle,
            this.defaultLoop,
            this.defaultVolume,
            this.autoLoop,
            () => (this.musicActive && this.lastTrack ? { title: this.lastTrack.title, artist: this.lastTrack.artist, contentType: this.lastTrack.contentType } : null)
          )
    this.lastLlmKey = llmKey
    this.sessionRowId = await this.deps.data.createSession(this.deviceId, Date.now())
  }

  private cancel(): void {
    // 手动打断：作废当前轮、清空排队，在途回调靠 turn 号退出
    const wasSpeaking = this.speaking
    this.turn += 1
    this.cancelled = true
    this.processing = false
    this.speaking = false
    this.playbackPending = false
    this.echoUntil = 0
    this.queue.length = 0
    // 注意：这里不清空 pendingCandidates（候选歌单）。cancel() 同时服务于
    // 重唤醒(REWAKE→session.cancel+session.start)与彻底退出(DISABLE/CANCEL)，
    // 而 agent 在重唤醒后是保留的（start() 的 agent!==null 早返回），
    // 为保持一致，正在等你「选第几首」的候选列表也应保留，否则重唤醒会丢掉选歌状态。
    // 候选列表只在新会话(start 全新分支)与会话结束(end)时清空。
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
    if (wasSpeaking) this.deps.send({ type: 'tts.stop' })
    // 手动打断证明是真人，解除回声兜底
    this.echo.release()
    this.syncDuplex()
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.asr.reset()
    this.vad.reset()
  }

  private end(): void {
    this.active = false
    this.cancelled = true
    this.turn += 1
    this.speaking = false
    this.playbackPending = false
    this.echoUntil = 0
    this.queue.length = 0
    this.pendingCandidates = null
    this.pendingNextFallback = false
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    if (this.sessionRowId) this.deps.data.endSession(this.sessionRowId, Date.now())
    this.asr.reset()
    this.vad.reset()
    // 会话显式结束：销毁对话记忆，下次 start 视为全新会话（不再保留历史/候选）。
    this.agent = null
    // 从设备注册表移除；下次同一 deviceId 的 start 会新建会话而非复用。
    this.deps.onEnded?.()
  }

  private sendError(code: ServerErrorCode, message: string): void {
    this.deps.send({ type: 'error', code, message: messages(this.lang).errors[code] ?? message })
  }

  close(): void {
    this.active = false
    this.playbackPending = false
    this.echoUntil = 0
    this.queue.length = 0
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.asr.reset()
    this.vad.reset()
  }
}

/**
 * 返回一句的切分位置（含句末标点），用于边生成边合成。
 * 无标点时若缓冲过长，退而按逗号或固定长度切，避免迟迟不出声。
 */
function sentenceCut(text: string): number {
  const match = text.match(/[。！？；!?;\n]/)
  if (match && match.index !== undefined) return match.index + 1
  if (text.length >= 60) {
    const comma = Math.max(text.lastIndexOf('，'), text.lastIndexOf(','))
    return comma > 0 ? comma + 1 : 60
  }
  return -1
}
