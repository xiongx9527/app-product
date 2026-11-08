import type { AsrProvider } from '../asr'
import type { TtsProvider } from '../tts'
import type { AgentService } from './agentService'
import type { DataService } from './dataService'
import type { ClientMessage, Lang, LocationInfo, ServerEvent, ServerErrorCode } from '../protocol'
import { createMusicSource, type MusicSource } from './music'
import { genreToKeyword, isGenericPlayPhrase, isSpokenContentRequest } from './music/types'
import { formatMemories, type MemoryStore, type RequestLocation } from './tools'
import {
  searchCandidates,
  needsCandidateList,
  candidateQuery,
  parseSelection,
  looksLikeBareMusicQuery,
  type MusicCandidate,
  type CandidateFetcher,
} from './music/musicCandidates'
import { detectMusicCommand } from './musicControl'
import { detectMemoryCommand } from './memoryControl'
import { messages } from '../i18n'
import { isNoise, resemblesSpoken } from '../asr/noiseFilter'
import { sanitizeForSpeech } from '../tts/sanitize'
import { EnergyVad } from '../vad/energyVad'
import { EchoGuard } from '../vad/echoGuard'

/** 播报期间最多排几句用户插话，超出直接拒收。 */
const MAX_QUEUE = 3

/** 单个语音会话的业务编排：ASR → 智能体 → TTS，并记录日志到数据库。 */
export interface VoiceSessionDeps {
  agentFactory: (
    lang: Lang,
    timezone?: string,
    locationProvider?: () => LocationInfo | null,
    musicSource?: MusicSource,
    emit?: (m: ServerEvent) => void,
    memoryStore?: MemoryStore,
    memoryContext?: string,
    requestLocation?: RequestLocation
  ) => AgentService
  asr: AsrProvider
  tts: TtsProvider
  data: DataService
  send: (event: ServerEvent) => void
  sendAudio: (bytes: Uint8Array) => void
  asrEndpointMs: number
  /** 构造音乐播放源；测试可注入桩避免联网，缺省用网关内置的无配置源 */
  musicSourceFactory?: () => MusicSource
  /** 检索候选歌曲（MusicBrainz）；测试可注入桩避免联网 */
  candidateFetcher?: CandidateFetcher
  /**
   * 设备稳定标识（来自客户端上报的 deviceId）；用于命令日志/会话落库归属设备。
   * 缺省空：旧客户端未上报，会话不进注册表、不复用。
   */
  deviceId?: string | null
  /** 会话显式结束（session.end）时回调：控制器据此从注册表移除，下次 start 视为全新 */
  onEnded?: () => void
  /** 懒加载定位的等待超时（毫秒）：客户端取不到/拒绝/离线时兑现为 null；测试可压短 */
  locationRequestTimeoutMs?: number
}

/**
 * “换一首 / 下一首 / 换个风格” 之类指令里，若用户没指定新的歌手/风格，返回 undefined
 * （让音乐源沿用当前上下文，放同歌手/同风格的下一首）；否则返回收敛后的关键词。
 * 这样「换一首」不会因没给风格而被路由到完全不相关的电台/歌曲。
 */
function nextPreference(text: string): string | undefined {
  if (!text) return undefined
  let kw = text
    .replace(/换一?首|下一?首|换个?风格|换一?个风格|切歌|来点别的|换台/g, '')
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
  /** 待用户用语音选择的候选歌曲列表：口播编号后挂起，下一句解析「第几首 / 歌名」 */
  private pendingCandidates: { items: MusicCandidate[]; query: string } | null = null
  private mode: 'wake' | 'dialog' = 'dialog'
  private sessionRowId = 0
  private agent: AgentService | null = null
  private readonly deviceId: string | null = null
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
        // 音乐播放源：无配置、始终可用（SomaFM 电台 + B 站搜索兜底），音乐工具始终注册
        this.musicSource = this.deps.musicSourceFactory
          ? this.deps.musicSourceFactory()
          : createMusicSource()
        void this.start(msg.sessionId, msg.lang, msg.timezone, msg.mode)
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
    }
  }

  /** 用当前音乐源解析下一首并下发 media.play；无音乐源或解析失败则静默忽略。 */
  private async nextMusic(genre?: string): Promise<void> {
    const source = this.musicSource
    if (!source) return
    try {
      const track = source.next ? await source.next(genre) : await source.resolve(genre)
      if (!track?.url) return
      this.deps.send({
        type: 'media.play',
        url: track.url,
        title: track.title,
        channel: track.channel,
      })
    } catch {
      // 解析失败（SomaFM/B 站都搜不到）：静默忽略，客户端保留上一首而不打断，
      // 由上层（工具/口播）统一告知用户「没找到这首歌」。
    }
  }

  /**
   * 执行已识别的音乐控制指令（绕开 LLM）：解析并下发 media.play，口播一句确认。
   * 只负责动作本身；asr.final 由 finalizeUtterance 统一下发，保证「我说」卡片显示这句。
   * 解析失败也只友好告知「没找到」，不报「操作失败」这类像系统故障的措辞。
   */
  /** 下发 media.play 并口播确认。 */
  private async playTrack(track: { url: string; title: string; channel?: string }, confirm: string): Promise<void> {
    this.deps.send({ type: 'media.play', url: track.url, title: track.title, channel: track.channel })
    await this.speakReply(confirm)
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
  private async offerCandidates(text: string, forceList = false): Promise<boolean> {
    const genre = genreToKeyword(text)
    if (!needsCandidateList(genre) && !forceList) return false
    const query = candidateQuery(genre)
    const m = messages(this.lang).music
    if (!query) {
      // 推荐但没具体歌手/风格：引导用户补充，绝不自动播放
      if (forceList) {
        await this.speakReply(m.recommendPrompt())
        return true
      }
      return false
    }
    const items = await searchCandidates(query, this.deps.candidateFetcher)
    if (items.length === 0) {
      if (forceList) {
        await this.speakReply(m.notFound(isSpokenContentRequest(text)))
        return true
      }
      return false
    }
    if (items.length === 1 && !forceList) {
      await this.playChosen(items[0], query)
      return true
    }
    this.pendingCandidates = { items, query }
    const labels = items.map((c) => (c.artist ? `${c.title}，${c.artist}` : c.title))
    await this.speakReply(
      (forceList ? m.recommend(labels) : m.candidates(labels)) + m.chooseHint()
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
      await this.playTrack(track, m.playing(track.title))
    } catch {
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
          await this.offerCandidates(text, true)
          break
        }
        case 'play': {
          // 只说「周杰伦」「稻香」「周杰伦的歌」：先给候选列表让用户选
          if (await this.offerCandidates(text)) break
          const track = await source.resolve(genre)
          if (!track?.url) throw new Error('no track')
          await this.playTrack(track, m.playing(track.title))
          break
        }
        case 'next': {
          // 没指定新歌手/风格（纯粹「换一首」）：传 undefined，让音乐源沿用当前上下文，
          // 放同歌手/同风格的下一首；指定了才用新关键词。
          const req = nextPreference(text)
          const track = source.next ? await source.next(req) : await source.resolve(req)
          if (!track?.url) throw new Error('no track')
          await this.playTrack(track, m.switched(track.title))
          break
        }
        case 'pause':
          this.deps.send({ type: 'media.pause' })
          await this.speakReply(m.paused())
          break
        case 'resume':
          this.deps.send({ type: 'media.resume' })
          await this.speakReply(m.resumed())
          break
        case 'stop':
          this.deps.send({ type: 'media.stop' })
          await this.speakReply(m.stopped())
          break
      }
    } catch {
      await this.speakReply(m.notFound(isSpokenContentRequest(text)))
    }
  }

  /** 处理「忘了XX / 清空记忆」直接指令：落地删除并口播确认，不进 LLM。 */
  private async runMemoryCommand(cmd: ReturnType<typeof detectMemoryCommand>): Promise<void> {
    if (!cmd || !this.deviceId) return
    const m = messages(this.lang).memory
    if (cmd.action === 'clear') {
      await this.deps.data.forgetMemory(this.deviceId)
      await this.speakReply(m.cleared())
      return
    }
    const n = await this.deps.data.forgetMemory(this.deviceId, cmd.topic)
    await this.speakReply(n > 0 ? m.forgot(cmd.topic, n) : m.nothingToForget())
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
      void this.deps.asr.push(frame).then((partial) => {
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
    const text = await this.deps.asr.finalize()
    if (!this.active || this.cancelled) return
    // 环境杂音被 ASR 误识别出的伪文本、以及播报被收回的回声，都静默丢弃，
    // 不进模型也不进队列，避免凭空多出一轮回答和 TTS
    if (!text || isNoise(text)) return

    // 上一轮给过候选歌曲列表，这一句优先当作「选第几首 / 说歌名」解析。
    // 必须在下面的回声比对之前：用户说的「第二首」「稻香」正是刚口播过的词，
    // 否则会被 resemblesSpoken 当成播报回声丢掉，导致永远选不中。
    if (this.pendingCandidates && await this.handleCandidateSelection(text)) return

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

    // 记忆直连指令（忘了XX / 清空记忆）在空闲时优先拦截，确定性落地，不进 LLM。
    // 与音乐直连同理：意图明确，直接forget/clear 并口播确认，避免模型幻觉「说忘了却没忘」。
    // 必须在音乐/LLM 分支之前，且同样只在空闲（未播报、未应答）时拦截。
    const memCmd = detectMemoryCommand(text)
    if (memCmd && !this.playbackPending && !this.processing && this.deviceId) {
      this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
      await this.runMemoryCommand(memCmd)
      return
    }

    // 音乐控制指令（播放/换一首/暂停/继续/停止）直接处理，不进 LLM，
    // 避免模型幻觉「说播放却没播放」。仅在空闲（未在播报、未在应答）时拦截，
    // 否则让现有排队/打断逻辑处理。没有配置音乐源时不拦截，交给 LLM 自然应答。
    // 没有明确播放动词、但像「只报了一个歌手/歌名」（如「周杰伦」「稻香」）时，
    // 也按「播放」处理：先给候选列表让用户选，检索不到就直接解析播放，不劫持闲聊/指令。
    const action = detectMusicCommand(text)
    const effectiveAction: NonNullable<ReturnType<typeof detectMusicCommand>> | null =
      action ?? (this.musicSource && looksLikeBareMusicQuery(text) ? 'play' : null)
    if (effectiveAction && !this.playbackPending && !this.processing && this.musicSource) {
      // 音乐直连同样要先下发 asr.final：这是「我说」卡片的数据源，不能因为绕开
      // LLM 就把用户说的话吞掉，否则卡片一直是空的。
      this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
      await this.runMusicCommand(effectiveAction, text)
      return
    }

    // 当前轮还没跑完：不打断、不作废，只把这句排进队列（不下发 asr.final，
    // 客户端「我说」卡片保持显示当前项，排队句由 asr.queued 只标数量）
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

    this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
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
        try {
          this.deps.data.insertCommandLog(this.deviceId, current, 'pending')
          ttsStarted = await this.runAgent(current, turn)
        } catch (err) {
          this.sendError('LLM_ERROR', (err as Error).message)
        }
        if (this.turn !== turn || this.cancelled) break
        // 必须等这一句真正播完，才轮到下一句：否则会掐掉尾音、
        // 也会让「你说」提前跳到下一句识别内容。
        if (ttsStarted) {
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
    for await (const frame of this.deps.tts.synthesize(sentence)) {
      if (this.turn !== turn || this.cancelled) return
      this.downlinkBytes += frame.byteLength
      this.echo.onDownlink()
      // 每下发一帧就把回声保护窗口往后挪：窗口始终盖住「最后一帧之后的一小段余音」
      this.echoUntil = Date.now() + 1200
      this.deps.sendAudio(frame)
    }
  }

  private async start(
    _sessionId: string,
    lang: Lang,
    timezone?: string,
    mode: 'wake' | 'dialog' = 'dialog'
  ): Promise<void> {
    this.lang = lang
    // 用户没带时区或带的是非法值就退回东 8 区
    this.timezone = timezone?.trim() || 'Asia/Shanghai'
    this.mode = mode
    this.active = true
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
    this.deps.asr.reset()
    this.vad.reset()

    // 重新武装：同一实例的二次 start（设备重连/重唤醒，agent 已存在）——
    // 保留 LLM 对话记忆与 pendingCandidates（候选歌单）、sessionRowId（同一会话日志），
    // 仅复位在途轮次与播放/回声状态，不清空跨轮记忆。这样助手在重唤醒/重连后不"失忆"。
    if (this.agent !== null) return

    // 全新会话：清空跨轮状态并重建 LLM
    this.pendingCandidates = null
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
    this.agent =
      mode === 'wake'
        ? null
        :                   this.deps.agentFactory(
            lang,
            this.timezone,
            () => this.getLocation(),
            this.musicSource,
            (m) => this.deps.send(m),
            memoryStore,
            memoryContext,
            () => this.requestClientLocation()
          )
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
    this.deps.asr.reset()
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
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    if (this.sessionRowId) this.deps.data.endSession(this.sessionRowId, Date.now())
    this.deps.asr.reset()
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
    this.deps.asr.reset()
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
