import type { AsrProvider } from '../asr'
import type { TtsProvider } from '../tts'
import type { AgentService } from './agentService'
import type { DataService } from './dataService'
import type { ClientMessage, Lang, LocationInfo, McpServerConfig, ServerEvent, ServerErrorCode } from '../protocol'
import type { GatewayConfig, AsrConfig, LlmConfig, TtsConfig } from '../config'
import type { VoiceConfig, ResolvedCapabilities } from '../voiceConfig'
import type {
  ContentSource, ContentSourceFactory, ContentResolverFactory, ContentExecutor,
  ContentExecutorDeps, ContentCandidateFetcher, ContentDashDeps,
} from './content/types'
import { formatMemories, type MemoryStore, type RequestLocation } from './tools'
import { preferenceKeywords } from './memory'
import { ensureAdtsFile, adtsKeyFor } from './media/mediaAdts'
import { MediaPlaybackCapability, createMediaPlaybackDeps, type MediaResolver } from './media/mediaPlaybackCapability'
import { MediaControl, detectVolumeCommand, detectSubtitleCommand, detectPlayModeCommand } from './media/mediaDetect'
import { cacheExternalAudio, getCachedAudioDuration, type MediaFetcher } from './media/mediaCache'
import { messages } from '../i18n'
import { isNoise, isForeignNoise, resemblesSpoken, stripTrailingEcho, pcmRms } from '../asr/noiseFilter'
import { ABS_FLOOR_RMS } from '../vad/energyVad'
import { AsrCorrector, type CorrectionEntry } from './asr/asrCorrector'
import type { CorrectionSyncer } from './asrCorrectionSync'
import type { AutoLearnEngine } from './autoLearn'
import { skillPromptAddon, type Skill, type SkillContext } from './skills/types'
import { sanitizeForSpeech } from '../tts/sanitize'
import { EnergyVad } from '../vad/energyVad'
import { EchoGuard } from '../vad/echoGuard'
import { buildHealth } from './health'
import { EchoCanceller } from './echoCanceller'
import { appendFile } from 'node:fs'
// ===== 关键链路日志（长期保留，不因定位完成而删除）=====
// 【2026-11-22】bargeDiag 迁到 diagLog.ts：同步 appendFileSync 改内存缓冲 + 异步落盘，
// 消除播报期高频同步 I/O 阻塞 iOS NodeMobile 事件循环。re-export 保持 controller 调用不变。
import { bargeDiag, setDiagStage } from '../diagLog'
export { bargeDiag }
let bargeDiagAt = 0
/** 累计收到的音频帧数（每 50 帧落一条），与 pb 状态/节流无关，确认网关是否真的在收帧 */
let bargeFrames = 0
let bargeLoudFrames = 0
/** 播报期全 0 静音帧跳过 AEC 的累计计数（每 500 条落一条日志，长期保留） */
let silentAecSkipped = 0

/** 播报期间最多排几句用户插话，超出直接拒收。 */
const MAX_QUEUE = 3

/**
 * 单轮 LLM 的硬超时（毫秒）：上游慢/挂起时主动舍弃本轮、断开下行播放，
 * 立即播友好兜底，不让用户干等。测试可经 deps.llmTimeoutMs 注入更短的值。
 */
const DEFAULT_LLM_TIMEOUT_MS = 15000
/** 深度思考（params.think=true）时的 LLM 硬超时：推理模型思考链可达 60~90s（实测 88s），
 *  必须比它长，否则 15s 误砍导致卡"正在思考"。120s 仍能在真挂起时兜底，不至于无限等。 */
const THINK_LLM_TIMEOUT_MS = 120000

/** 自动记忆抽取时，喂给抽取引擎的「最近用户原话」最多保留几句（足够判断稳定性即可）。 */
const MAX_HISTORY_TURNS = 8

/** 自动记忆合并（摘要）触发阈值默认值：记忆条数达到此值后，每隔 CONSOLIDATE_EVERY 轮抽取合并去重一次。 */
const DEFAULT_CONSOLIDATE_THRESHOLD = 30

/** 自动记忆合并（摘要）频率默认值：每这么多次抽取触发一次合并（避免每次都打 LLM）。 */
const DEFAULT_CONSOLIDATE_EVERY = 5

/**
 * 真人会用的极短应答/单字指令（配合 VAD 幻觉二级判断）。这些单字虽然 VAD 语音短，
 * 但是有意义的用户输入，不能当打嗝幻觉丢弃。与 isNoise 的 FILLERS（无语义语气词）不同——
 * 这里是「有语义的单字」，宁可放行交给下游，也不误杀。
 * 数字选号由 /^\d+$/ 单独放行，不在此集合。
 */
const EFFECTIVE_SHORT_WORDS = new Set([
  '好', '好的', '是', '对', '行', '可以', '停', '走', '滚', '去', '来', '要', '不要',
  '在', '给', '嗯', '啊', '继续', '再来', '下一首', '下一', '第一', '第二', '第三',
])

/** 默认 ASR 同音纠错器（确定性、零误纠）。懒加载，避免模块加载时的 pinyin 初始化开销。 */
let defaultAsrCorrector: AsrCorrector | null = null
function getDefaultAsrCorrector(): AsrCorrector {
  if (!defaultAsrCorrector) defaultAsrCorrector = new AsrCorrector()
  return defaultAsrCorrector
}

/** 网关启动时把 SQLite 词表灌入默认纠错器（管理接口改词后也调它即时刷新）。 */
export function loadAsrCorrections(corrections: readonly CorrectionEntry[]): void {
  getDefaultAsrCorrector().load(corrections)
}

/** 单个语音会话的业务编排：ASR → 智能体 → TTS，并记录日志到数据库。 */
export interface VoiceSessionDeps {
  agentFactory: (
    llm: LlmConfig,
    lang: Lang,
    timezone?: string,
    locationProvider?: () => LocationInfo | null,
    memoryStore?: MemoryStore,
    memoryContext?: string,
    requestLocation?: RequestLocation,
    getNowPlaying?: () => { title: string; artist?: string; contentType?: string } | null,
    autoMemory?: boolean,
    mcpServers?: McpServerConfig[],
    autoLearnEngine?: AutoLearnEngine,
    promptAddon?: string
  ) => AgentService | Promise<AgentService>
  /** 本次会话启用的 skill 模块；由网关按配置加载，会话 start 时各 create 一个实例。 */
  skillModules?: import('./skills/types').SkillModule[]
  /** 按解析出的能力配置构造 ASR/TTS 实例（voice 来自 session.start，故在 start 时构建） */
  createAsr: (cfg: AsrConfig) => AsrProvider
  createTts: (cfg: TtsConfig) => TtsProvider
  /** 把客户端设置的语音服务配置展开成三套能力配置 */
  resolveVoice: (voice?: VoiceConfig) => ResolvedCapabilities
  data: DataService
  /** ASR 纠错同步器：有则 learn_correction 工具可用（本地学习+择机上传 9529） */
  correctionSyncer?: CorrectionSyncer
  send: (event: ServerEvent) => void
  sendAudio: (bytes: Uint8Array) => void
  asrEndpointMs: number
  /** 构造内容源（按客户端 playback.source）；测试可注入桩避免联网，缺省由装配层提供内置源。 */
  contentSourceFactory: ContentSourceFactory
  /** 把内容源适配成系统能力层 resolver；由装配层提供（核心不 import 具体源/resolver）。 */
  contentResolverFactory: ContentResolverFactory
  /** 构造内容执行器（音乐等业务）；由装配层提供，核心只认 ContentExecutor 接口。 */
  contentExecutorFactory: (deps: ContentExecutorDeps) => ContentExecutor
  /** dash 依赖（needsProxy 等）由装配层注入，核心不 import 具体内容域。 */
  contentDashDeps: ContentDashDeps
  /** 候选检索器（MusicBrainz）；测试可注入桩避免联网。 */
  candidateFetcher?: ContentCandidateFetcher
  /** ASR 同音错字纠正（定稿时当场纠，让「我说」框显示正确文字）。测试可注入桩；缺省用内置 AsrCorrector。 */
  asrCorrect?: (text: string) => string
  /** 外部音频本地短链缓存：下载 mp3 落盘返回 /media/s/<key>.mp3。测试默认 no-op（返回 null→回退原 url）。 */
  mediaCache?: (url: string, fetcher?: MediaFetcher) => Promise<string | null>
  /** 单轮 LLM 超时（毫秒）：超时主动舍弃本轮、断开下行播放、立即播友好兜底。测试注入更小值。 */
  llmTimeoutMs?: number
  /** TTS 帧间看门狗（毫秒）：上游挂起不产帧时断开本句，对话链绝不卡死。测试注入更小值。 */
  ttsFrameGapMs?: number
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
  /** 自动记忆合并（摘要）触发阈值：记忆条数达到此值才周期性合并去重（缺省见模块常量） */
  consolidateThreshold?: number
  /** 自动记忆合并（摘要）频率：每这么多次抽取触发一次合并（缺省见模块常量） */
  consolidateEvery?: number
}

export class VoiceSessionService {
  private active = false
  private cancelled = false
  /**
   * 「跳过当前句」标志：播报/思考中重新喊唤醒词时置位，只让当前这句的在途下发停止，
   * 不 ++turn、不置 cancelled、不清队列——runTurn 的 while 据此继续消费下一句。
   * 与 cancelled 正交：cancelled 作废整条链，skipRequested 只作废链里的当前一项。
   * 每句在 runTurn 循环顶部复位。
   */
  private skipRequested = false
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
  private musicSource: ContentSource | undefined = undefined
  /**
   * 最后一次播放的百科/诗词媒体（tts）：「重新播放」要重现它而不是找歌。
   * 记下重播所需的全部字段——音频 url/本地短链、封面、字幕行、标题；音乐重播仍走 lastTrack。
   */
  private lastTtsMedia: {
    url: string; title: string; audioPath?: string; cover?: string;
    lines: Array<{ time: number; text: string }>
  } | null = null
  /** 最近一次 session.start 带下来的语音来源配置：供 announceCapabilityProblems 按「实际会用的那套能力」
   *  探测就绪状态（而非永远探测网关默认的内置），与 /api/health 的 provider-aware 探测保持一致。 */
  private lastVoice: VoiceConfig | undefined = undefined
  /**
   * 分批 TTS 正在下发中（ttsChain 未全部完成）。逐批流水线播放时，批与批之间原生会检测到
   * 短暂静默而误发 playback_done；此时不能当成"整轮播完"去 resolvePlayback / 发 tts.idle，
   * 否则前端提前收尾（状态变"本轮完成/正在听"）、runTurn 提前推进、退下后 cancelled 掐掉剩余批次。
   * 只有全部批次下发完（ttsDispatching=false）后到来的 playback_done 才是真播完。
   */
  private ttsDispatching = false
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
  /** 自动字幕开关：来自客户端设置页 session.start.playback.autoSubtitle，缺省开启。经 player deps 读取。 */
  private autoSubtitle = true
  /** 自动记忆（自动抽取）开关：来自客户端设置页 session.start.memory.auto，缺省关。开启时助手才会主动沉淀长期记忆。 */
  private autoMemory = false
  /** 自动记忆合并（摘要）阈值：来自客户端设置页 session.start.memory.consolidateThreshold，缺省走模块常量/网关配置。 */
  private consolidateThreshold = DEFAULT_CONSOLIDATE_THRESHOLD
  /** 自动记忆合并（摘要）频率：来自客户端设置页 session.start.memory.consolidateEvery，缺省走模块常量/网关配置。 */
  private consolidateEvery = DEFAULT_CONSOLIDATE_EVERY
  /** 最近几句用户原话（仅真实对话轮次）：作为抽取引擎的上下文，判断哪些事实值得长期记住。 */
  private recentUserTurns: string[] = []
  /** 自动抽取累计次数：用于节流合并（摘要）触发频率。 */
  private autoExtractRuns = 0
  /**
   * 本次会话的 skill 实例（由 deps.skillModules 各 create 一个）。偏好追问等业务规则
   * 已迁进 skill，状态在实例闭包里；网关只在对应时机按序调用生命周期钩子。
   */
  private skills: Skill[] = []
  /** 所有启用 skill 的提示词片段拼接结果（构造 agent 时一次算好，传给 agentFactory）。 */
  private skillPromptAddon = ''
  private mode: 'wake' | 'dialog' = 'dialog'
  private sessionRowId = 0
  private agent: AgentService | null = null
  /** MCP 服务器列表：来自客户端 session.start.mcp.servers，建连时交给 agentFactory 注册进工具箱；重建/结束时据此关闭旧客户端。 */
  private mcpServers: McpServerConfig[] = []
  private readonly deviceId: string | null = null
  /** 本次会话的 ASR / TTS 实例：在 start() 里按客户端设置的语音配置构建（地址/密钥/参数来自设置） */
  private asr!: AsrProvider
  private tts!: TtsProvider
  /**
   * 客户端持续上行（含静音），所以句末不再靠「收不到数据」判断：
   * 只有 VAD 判为语音的帧才喂给 ASR，最后一个人声帧之后静音够久才定稿。
   */
  private readonly vad = new EnergyVad()
  /**
   * 播报期软件回声消除：用下发的 TTS 作参考，从上行采集里减掉扬声器回声，只留真人插话再送 VAD/ASR。
   * 原生/AEC 硬件消不干净的 TTS 回声是「播报期插话识别成 TTS 内容」的根因，这里在网关侧补上。
   */
  private readonly aec = new EchoCanceller()
  /** 本句是否推过 TTS 参考（没推参考时 AEC 输出=原样，避免非播报期误处理）。 */
  private aecActive = false
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
  /** barge-in duck：播报期检测真人开口时压低 TTS；避免重复下发，记住当前 duck 态。 */
  private ducked = false
  /** 本次 utterance 期间是否在播报期检测到真人开口。播报期插话定稿常拖到播报结束后
   *  （pb 已 false），单凭 playbackPending 会漏判、把插话当普通对话而非队列项。此标志
   *  在 setDuck(true) 且 playbackPending 时置位，定稿时读取并清除。 */
  private bargeInDuringPlayback = false
  /** duck 后多久没再有人声就恢复音量（用户说完一句的尾音余量）。 */
  private duckReleaseTimer: ReturnType<typeof setTimeout> | null = null
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
  /**
   * 本次播放窗口是否已发过 tts.idle。armPlaybackWait（每句开头）清零，emitTtsIdle 置位。
   * 正常由原生 playback_done 回执发一次；iOS 曾出现原生打了「TTS idle detected」但回执没到网关
   * （真机铁证：syslog 有 idle、网关 diag 无 PB-DONE），导致前端永远等不到 tts.idle、卡在
   * 「正在播报」直到 watchdog 强制收尾，此时会话已被 T1/T2 退下 → 变成「正在听」却识别不了。
   * 兜底：播放计时器按已下发字节估算音频播完后，若回执仍没来就补发一次。幂等保证一轮只发一次，
   * Android 回执正常时兜底计时器已被清掉、永不触发——对 Android 零影响。
   */
  private ttsIdleSentForTurn = false
  /** 等待客户端「播完」回执的 resolve；processing 会一直保持到它触发。
   *  参数 fallback=true 表示计时器自然到期（回执可能丢失），需补发 tts.idle；
   *  false 表示原生回执已到或主动取消，不要补发。 */
  private playbackResolve: ((fallback: boolean) => void) | null = null
  private playbackTimer: ReturnType<typeof setTimeout> | null = null
  /** 定稿串行链：多个 endpoint 定时器重叠时逐句处理，不丢句也不抢同一段缓冲。 */
  private finalizeChain: Promise<void> = Promise.resolve()

  /**
   * 媒体播放系统能力（唯一实例）：skill 与 play_media 工具共用，状态唯一。
   * send 用闭包指向 deps.send——bindTransport 换连接后仍能下发到存活 socket。
   */
  private media: MediaPlaybackCapability
  /** 通用媒体控制（系统能力，非 skill）：音量/字幕/播放模式/pause/resume/stop/replay。 */
  private mediaControl!: MediaControl // start() 里按当前 lang 构造
  /** 内容播放执行器（由装配层注入实现）：选曲/候选/口播，核心只认通用接口。 */
  private content!: ContentExecutor // start() 里构造

  constructor(private readonly deps: VoiceSessionDeps) {
    this.deviceId = deps.deviceId ?? null
    const mediaDeps = createMediaPlaybackDeps({
      send: (e) => this.deps.send(e),
      ensureAdtsFile,
      needsProxy: this.deps.contentDashDeps.needsProxy,
      adtsKeyFor,
    })
    // 媒体解析能力用 getter 延迟读当前 musicSource（session.playback.source 在 session.start 才确定，
    // 且切换来源后要立即生效）；换源只换 source，能力层与 skill 都不动。
    mediaDeps.resolver = {
      resolve: (params) => this.musicResolver().resolve(params),
      next: (params) => this.musicResolver().next?.(params) ?? Promise.resolve(null),
      getSubtitle: (title, artist) => this.musicResolver().getSubtitle?.(title, artist) ?? Promise.resolve(null),
    }
    this.media = new MediaPlaybackCapability(mediaDeps)
  }

  /** resolver 缓存：源变了（切换来源）才重建，其余时候复用。 */
  private cachedMusicSource: ContentSource | undefined = undefined
  private cachedMusicResolver: MediaResolver | undefined = undefined

  /** 按当前内容源取 MediaResolver（换源即时生效，能力层/skill 不感知）。 */
  private musicResolver(): MediaResolver {
    if (!this.musicSource) {
      // 无源：返回空 resolver，高层方法会解析失败、由调用方回退 LLM（不谎报「没这首歌」）
      return { resolve: async () => null }
    }
    if (this.cachedMusicSource !== this.musicSource || !this.cachedMusicResolver) {
      const resolver = this.deps.contentResolverFactory(this.musicSource)
      this.cachedMusicSource = this.musicSource
      this.cachedMusicResolver = resolver
      return resolver
    }
    return this.cachedMusicResolver
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
      bargeDiag(`CTRL-PARSE-FAIL raw=${raw.slice(0, 160)}`)
      this.sendError('LLM_ERROR', '无法解析控制消息')
      return
    }
    switch (msg.type) {
      case 'session.start':
        this.location = msg.location ?? null
        // 音乐播放源：来自客户端设置页（session.start.playback.source），缺省百度；
        // 始终可用（SomaFM 电台 + B 站搜索兜底），音乐工具始终注册。
        this.musicSource = this.deps.contentSourceFactory(msg.playback?.source)
        // 自动字幕开关：来自客户端设置页（session.start.playback.autoSubtitle），缺省开启。
        this.autoSubtitle = msg.playback?.autoSubtitle ?? true
        // 默认循环次数 / 默认音量：来自客户端设置页（session.start.playback），缺省 3 / 0.5；
        // 不合法值归一到安全默认：循环次数取非负整数（0/1 均表示不循环），音量收敛到 [0,1]。
        // 音量状态以默认值为起点，后续语音「调大/调小」在其上相对增减。
        const pb = msg.playback
        this.defaultLoop = typeof pb?.defaultLoop === 'number' ? Math.max(0, Math.floor(pb.defaultLoop)) : 3
        this.defaultVolume = typeof pb?.defaultVolume === 'number' ? Math.min(1, Math.max(0, pb.defaultVolume)) : 0.5
        this.autoLoop = typeof pb?.autoLoop === 'boolean' ? pb.autoLoop : false
        this.media.syncVolumeFromClient(this.defaultVolume)
        // 自动记忆开关：来自客户端设置页（session.start.memory.auto），缺省关。
        // 仅控制助手是否主动沉淀长期记忆；手动指令（记录下 / 帮我记 等）始终生效。
        this.autoMemory = typeof msg.memory?.auto === 'boolean' ? msg.memory.auto : false
        // 合并（摘要）阈值/频率：优先用客户端设置页下发的 per-session 值（非负整数，0 表示每轮都合并），
        // 否则回退到网关运行配置（VoiceSessionDeps 注入），再不行用模块常量。收敛到 >=0 的整数。
        const toPosInt = (v: unknown, fallback: number): number => {
          const n = Number(v)
          return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
        }
        this.consolidateThreshold = toPosInt(msg.memory?.consolidateThreshold, this.deps.consolidateThreshold ?? DEFAULT_CONSOLIDATE_THRESHOLD)
        this.consolidateEvery = toPosInt(msg.memory?.consolidateEvery, this.deps.consolidateEvery ?? DEFAULT_CONSOLIDATE_EVERY)
        // MCP 服务器列表：来自客户端设置页（session.start.mcp.servers），缺省空（不连接任何服务器）。
        // 建连会话据此连上并把工具注册进助手工具箱；单个失败不影响会话（在 agentFactory 内跳过）。
        this.mcpServers = msg.mcp?.servers ?? []
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
        this.musicSource = this.deps.contentSourceFactory(msg.source)
        // 自动字幕开关实时切换：设置页打开/关闭后由客户端随本消息推来。
        if (typeof msg.autoSubtitle === 'boolean') this.autoSubtitle = msg.autoSubtitle
        // 默认循环次数 / 默认音量同样可随设置页实时刷新，下次新播放（点歌/换一首）即生效。
        if (typeof msg.defaultLoop === 'number') this.defaultLoop = Math.max(0, Math.floor(msg.defaultLoop))
        if (typeof msg.defaultVolume === 'number') this.defaultVolume = Math.min(1, Math.max(0, msg.defaultVolume))
        if (typeof msg.autoLoop === 'boolean') this.autoLoop = msg.autoLoop
        break
      case 'session.cancel':
        this.cancel()
        break
      case 'session.skip_current':
        bargeDiag(`SKIP-CURRENT recv drop=${msg.dropText ?? ''} pb=${this.playbackPending} proc=${this.processing} queue=${this.queue.length}`)
        this.skipCurrent(msg.dropText)
        break
      case 'session.end':
        this.end()
        break
      case 'session.playback_done':
        // 【2026-11-22 彻底修复】tts.idle 的唯一权威出口 = 原生播空回执。
        // 分批流水线播放时，批与批之间原生会检测到短暂静默而误发 playback_done——这不是真播完。
        // 若 ttsDispatching=true（还有批次在合成/下发中），忽略它：不 resolvePlayback、不发 tts.idle，
        // 否则前端提前收尾（状态变"本轮完成/正在听"）、runTurn 提前推进、退下后掐掉剩余批次。
        if (this.ttsDispatching) {
          bargeDiag(`PB-DONE IGNORED (分批间隙误判) pb=${this.playbackPending} queue=${this.queue.length} turn=${this.turn}`)
          break
        }
        bargeDiag(`PB-DONE recv pb=${this.playbackPending} queue=${this.queue.length} speaking=${this.speaking} ` +
          `turn=${this.turn} cancelled=${this.cancelled} downlink=${this.downlinkBytes} -> tts.idle`)
        this.resolvePlayback('pcm-done')
        this.emitTtsIdle('pcm-done')
        break
      case 'session.diag':
        // 临时诊断：客户端 onPcm 真实状态落盘（定位后移除）
        bargeDiag(
          `CLIENT state=${msg.state} speaking=${msg.speaking} cue=${msg.cue} `
          + `muted=${msg.muted} frames=${msg.frames} rms=${msg.rms} connected=${msg.connected} pb=${this.playbackPending}`
          + (msg.trace ? ` trace=${msg.trace}` : '')
        )
        break
      case 'music.next':
        // 客户端点「换一首 / 换个风格」（协议消息名保留）：委托内容执行器解析下一首。
        void this.content.nextFromClient(msg.genre)
        break
      case 'music.volume':
        // 客户端拖动滑块回执当前音量：保持网关音量状态同步，保证后续的「调大/调小」相对增减准确。
        if (Number.isFinite(Number(msg.volume))) {
          this.media.syncVolumeFromClient(Number(msg.volume))
        }
        break
    }
  }

  /**
   * 音乐/音量/记忆等「意图明确」的指令直连拦截，确定性落地、绕开大模型。
   * 复用于两处：
   *  - finalizeUtterance 的空闲实时定稿；
   *  - runTurn 里排队句的回放（否则排队句会被丢给大模型，由 skill 提示引导大模型播放，
   *    破坏「按歌手浏览要给候选列表让用户选」的直连行为）。
   * 调用方负责保证「不在播报中」（playbackPending=false）并自行下发 asr.final；
   * 不在此处再判 playbackPending/processing——回放时 processing 仍为 true 属正常。
   * 返回 true 表示已被直连命令消费。
   */
  private async handleDirectCommand(text: string): Promise<boolean> {
    // 通用媒体控制（音量/字幕/播放模式/pause/resume/stop/replay/loop）由系统能力层处理，
    // 与内容 skill 无关；内部 detect 顺序已保证 playMode/pause/stop 不被音乐 play 抢匹配。
    if (await this.mediaControl.handle(text)) return true
    // skill 调度放在这里（mediaControl 之后）：内容 skill 的 play 正则含裸
    // 「播放/放」，若提前会抢走「播放新闻/切换播放模式…」；放在这些守卫之后才安全。
    // 百科(33)/诗词(35) skill 排在音乐(40)之前，time/weather/auspicious 不含播放词不受影响。
    // 百科 skill 在好价（detectProductQuery，调度之后）之前被消费——「查百科」含「查」不会被好价误中。
    if (await this.dispatchDirectCommand(text)) return true
    // 裸内容兜底（"周杰伦"）：detect 未覆盖的单一名词，交 skill 的 onBareQuery。
    // 通用控制（pause/resume/stop/replay/loop）已由 mediaControl 在此前消费。
    if (await this.dispatchBareQuery(text)) return true
    // 商品/好价由 deals skill（priority 950，最靠后）在 dispatchDirectCommand 里消费，
    // 不抢记忆/音量/字幕/播放模式/音乐等既有直连命令。
    return false
  }

  /**
   * 时间/日期直连：本地时钟按会话时区取值，直接口播，零网络、零 LLM。
   * 按识别出的意图分流——问时间只报时分；问日期（星期几 / 几月几号）必须报全
   * 「X年X月X日 星期X」；两样都问就都报。日期文案按 lang 本地化（weekday 由 Intl 产出）。
   */


  /**
   * 通用自动学习（数据源直连）：把"识别词 → 数据源返回的规范词"交给 autoLearn 引擎。
   * 引擎按已注册规则判断学什么（同音纠错是第一条），直连层不关心具体规则。
   * 百科/诗词等数据源会把识别词纠正成规范词（李存旭→李存勖、滕王格世→滕王阁序），
   * 这是现成的学习信号，不必等 LLM 调工具（本地小模型不支持 function calling）。
   */
  private async autoLearnCorrection(wrong: string | null, correct: string | null): Promise<void> {
    const w = (wrong ?? '').trim()
    const c = (correct ?? '').trim()
    if (!w || !c || w === c) return
    const syncer = this.deps.correctionSyncer
    if (!syncer) return
    try {
      // 引擎命中时会统一打带 source/rule 的 AUTO-LEARN 日志，这里不再重复打
      await syncer.autoLearn(w, c, { source: 'direct' })
    } catch {
      // 学习失败不影响主流程
    }
  }

  /**
   * 首次 start 时构造 skill 实例（含提示词片段）。ctx 用 getter 读会话的当前值——
   * skill 生命周期可能跨重武装（agent/memoryStore 会变），getter 保证它总拿到最新的。
   * 已在 onSessionReset('cancel'/'end') 里清状态，但实例本身保留（重武装不丢跨轮上下文，
   * 与旧的 pendingMemory 语义一致）。
   */
  private ensureSkills(): void {
    if (this.skills.length > 0) return
    const modules = this.deps.skillModules ?? []
    if (modules.length === 0) return
    const self = this
    const ctx: SkillContext = {
      get lang() { return self.lang },
      get timezone() { return self.timezone },
      get deviceId() { return self.deviceId },
      get data() { return self.deps.data },
      get memoryStore() { return self.memoryStore },
      get agent() { return self.agent },
      send: (e) => self.deps.send(e),
      speak: (t) => self.speakReply(t),
      queueRemaining: () => self.queue.length,
      getLocation: () => self.getLocation(),
      requestClientLocation: () => self.requestClientLocation(),
      // 媒体播放系统能力：skill 与工具共用这一个实例，状态唯一。
      media: self.media,
      // 内容播放请求：内容 skill 识别意图后委托通用执行器（实现由装配层注入）。
      content: {
        play: async (text) => { await self.content.run('play', text); return true },
        next: async (text) => { await self.content.run('next', text); return true },
        recommend: async (text) => { await self.content.run('recommend', text); return true },
        // 选号由核心在 finalizeUtterance 的回声比对前调 player.selectCandidate，这里返回 false 避免重复消费。
        select: async () => false,
        setCandidates: (items, query) => self.content.setCandidates(items, query),
        clearDeals: () => self.dispatchClearOtherCandidates(),
      },
      // 通用内容能力（音频落盘/时长/dash 短链）：skill 只调能力，不自己实现。
      mediaTools: {
        cacheAudio: (url) => (self.deps.mediaCache ?? cacheExternalAudio)(url),
        audioDuration: (path) => getCachedAudioDuration(path),
        ensureAdts: (raw) => ensureAdtsFile(raw),
        adtsKey: (raw) => adtsKeyFor(raw),
      },
      // 跨业务状态由核心持有：百科/诗词的「重新播放」记忆 + ASR 同音纠错学习。
      rememberTtsMedia: (media) => { self.lastTtsMedia = media },
      autoLearn: (wrong, correct) => self.autoLearnCorrection(wrong, correct),
      // 长期记忆偏好关键词（纯读取）：各内容 skill 在无明确内容时据此个性化推荐，好价据此排序。
      getPreferenceKeywords: async () => {
        try {
          return preferenceKeywords((await self.memoryStore?.list()) ?? [])
        } catch {
          return []
        }
      },
    }
    this.skills = modules.map((m) => m.create(ctx))
    this.skillPromptAddon = skillPromptAddon(modules, self.lang)
  }

  /**
   * 直连意图调度：按 skill 的 priority 升序（ensureSkills 已排序）依次询问 onDirectCommand，
   * 任一 skill 返回 consumed=true 即短路，不再走后续 skill / LLM。
   * 业务规则全在各 skill 内；这里只做调度，不含任何意图识别或执行逻辑。
   * 单个 skill 抛错吞掉、继续下一个，不拖垮会话（同 MCP 的失败跳过）。
   */
  private async dispatchDirectCommand(text: string): Promise<boolean> {
    for (const skill of this.skills) {
      try {
        const r = await skill.onDirectCommand?.(text)
        if (r?.consumed) return true
      } catch (err) {
        console.warn('[skills] onDirectCommand 抛错，已跳过:', (err as Error)?.message)
      }
    }
    return false
  }

  /** 裸内容查询兜底：按 priority 依次询问 skill 的 onBareQuery（网关不 import 具体裸查询识别）。 */
  private async dispatchBareQuery(text: string): Promise<boolean> {
    for (const skill of this.skills) {
      try {
        if (await skill.onBareQuery?.(text)) return true
      } catch (err) {
        console.warn('[skills] onBareQuery 抛错，已跳过:', (err as Error)?.message)
      }
    }
    return false
  }

  /** 通用执行器选中带 bvid 的候选后，按序问 skill 谁能播这条外部视频音轨。 */
  private async dispatchExternalVideo(c: { bvid?: string; title: string; cover?: string }): Promise<void> {
    for (const skill of this.skills) {
      try {
        if (await skill.playExternalVideo?.(c)) return
      } catch (err) {
        console.warn('[skills] playExternalVideo 抛错，已跳过:', (err as Error)?.message)
      }
    }
  }

  /** 通用媒体 stop 时通知所有 skill 清跨轮播放上下文（新闻待选列表等）。 */
  private dispatchMediaStop(): void {
    for (const skill of this.skills) {
      try {
        skill.onMediaStop?.()
      } catch (err) {
        console.warn('[skills] onMediaStop 抛错，已跳过:', (err as Error)?.message)
      }
    }
  }

  /** 是否有 skill 挂起了语音报号可选候选（商品列表等），供幻觉判断放行单字数字。 */
  private anySkillHasCandidates(): boolean {
    return this.skills.some((s) => s.hasCandidates?.() === true)
  }

  /** 定稿时语音选择某 skill 的候选（商品「第二件」），须早于回声比对调用。 */
  private async dispatchCandidateSelection(text: string): Promise<boolean> {
    for (const skill of this.skills) {
      try {
        if (await skill.onCandidateSelection?.(text)) return true
      } catch (err) {
        console.warn('[skills] onCandidateSelection 抛错，已跳过:', (err as Error)?.message)
      }
    }
    return false
  }

  /** 设置内容候选时清掉其它 skill 的候选（商品/音乐互斥）。 */
  private dispatchClearOtherCandidates(): void {
    for (const skill of this.skills) {
      try {
        skill.clearCandidates?.()
      } catch (err) {
        console.warn('[skills] clearCandidates 抛错，已跳过:', (err as Error)?.message)
      }
    }
  }

  /**
   * 一句定稿时按序调用所有 skill 的 onFinalize。任一 skill 返回 consumed=true 即表示这句
   * 被它消费，网关不再走后续直连命令 / LLM。单个 skill 抛错吞掉，不拖垮会话（同 MCP）。
   */
  private async dispatchFinalize(text: string): Promise<boolean> {
    for (const skill of this.skills) {
      try {
        const r = await skill.onFinalize?.(text)
        if (r?.consumed) return true
      } catch (err) {
        console.warn('[skills] onFinalize 抛错，已跳过:', (err as Error)?.message)
      }
    }
    return false
  }

  /** LLM 文本收尾时收集所有 skill 要追加的追问，按顺序拼成一段（同 TTS 链、无停顿）。 */
  private dispatchAgentReply(text: string, full: string): string {
    const parts: string[] = []
    for (const skill of this.skills) {
      try {
        const t = skill.onAgentReply?.(text, full)?.appendTts
        if (t) parts.push(t)
      } catch (err) {
        console.warn('[skills] onAgentReply 抛错，已跳过:', (err as Error)?.message)
      }
    }
    return parts.join('')
  }

  /** 一句播完后按序调用所有 skill 的 onAfterSpeak（兜底追问）。 */
  private async dispatchAfterSpeak(text: string): Promise<void> {
    for (const skill of this.skills) {
      try {
        await skill.onAfterSpeak?.(text)
      } catch (err) {
        console.warn('[skills] onAfterSpeak 抛错，已跳过:', (err as Error)?.message)
      }
    }
  }

  /** 会话取消/结束/重武装时通知所有 skill 清状态。 */
  private dispatchSessionReset(reason: 'cancel' | 'end' | 'start'): void {
    for (const skill of this.skills) {
      try {
        skill.onSessionReset?.(reason)
      } catch (err) {
        console.warn('[skills] onSessionReset 抛错，已跳过:', (err as Error)?.message)
      }
    }
  }

  /** 记录本轮用户原话（仅真实对话轮次），供抽取引擎作为最近上下文；最多保留最近若干句。 */
  private pushUserTurn(text: string): void {
    const t = (text ?? '').trim()
    if (!t) return
    this.recentUserTurns.push(t)
    if (this.recentUserTurns.length > MAX_HISTORY_TURNS) this.recentUserTurns.shift()
  }

  /**
   * 自动记忆：开关开启时，每轮真实对话结束后异步抽取并沉淀长期记忆（不阻塞语音播报）。
   * - 抽取：把最近几句用户原话交给抽取引擎，得到可长期记住的稳定事实，按 key 覆盖写入。
   * - 摘要：记忆较多时周期性合并去重，避免无限膨胀；合并结果只会更少或持平，绝不放空。
   * 失败静默丢弃、不影响正常对话；抽取是异步的，会话若立刻结束可能来不及落库（下一轮再补）。
   */
  private async runAutoMemory(): Promise<void> {
    if (!this.autoMemory || !this.memoryStore || !this.agent) return
    try {
      const existing = await this.memoryStore.list()
      const extracted = await this.agent.extractMemories(this.recentUserTurns.slice(), existing)
      if (extracted.length === 0) return
      for (const e of extracted) {
        await this.memoryStore.save(e.key, e.value)
      }
      // 合并（摘要）：条数达标且每 N 轮触发一次；要求合并后条数 ≤ 合并前，防止模型误删把记忆清空。
      // 阈值/频率来自客户端设置页下发（per-session），回退网关运行配置，再回退模块常量，便于调参、不写死。
      const threshold = this.consolidateThreshold
      const every = this.consolidateEvery
      const total = existing.length + extracted.length
      this.autoExtractRuns += 1
      if (total >= threshold && this.autoExtractRuns % every === 0) {
        const latest = await this.memoryStore.list()
        const consolidated = await this.agent.consolidateMemories(latest)
        if (consolidated.length > 0 && consolidated.length <= latest.length) {
          await this.memoryStore.forget()
          for (const e of consolidated) await this.memoryStore.save(e.key, e.value)
        }
      }
    } catch {
      // 自动记忆失败不影响正常对话：静默丢弃，下一轮再试
    }
  }

  /**
   * 口播一句短确认：复用 TTS 下发链路（tts.start → 流式 → tts.end），不进 LLM。
   * 两种语境：
   * - 空闲直连（finalize 链，processing=false）：自管 turn 与播放等待（arm + tighten + await）。
   * - runTurn 串行链内（直连命令回放 / LLM 超时兜底，processing=true）：turn 与播放等待都归
   *   runTurn——这里绝不 ++this.turn（会把 runTurn 的 turn 快照弄失效、链 break、队列从此
   *   无人消费，正是「排队卡死」的根因），也不 arm/cancel 等待；runTurn 的 await playback
   *   等兜底句真正播完回执后才 shift 下一句，避免下一句被客户端抗重复挡掉而无声。
   */
  private async speakReply(text: string): Promise<void> {
    if (!this.processing) {
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
        this.deps.send({ type: 'tts.end', durationMs: this.estimatedSpeechMs() })
      }
      this.tightenPlaybackTimeout()
      await playback
      return
    }
    // runTurn 链内：状态、事件、音频都发，但 turn/等待全归 runTurn
    this.speaking = true
    this.playbackPending = true
    this.deps.send({ type: 'tts.start', format: 'pcm16', sampleRate: 24000 })
    this.deps.send({ type: 'llm.delta', text })
    this.deps.send({ type: 'llm.done' })
    await this.speakSentence(text, this.turn)
    if (!this.skipRequested && !this.cancelled) {
      this.speaking = false
      this.deps.send({ type: 'tts.end', durationMs: this.estimatedSpeechMs() })
    }
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
    // 本帧 RMS（供 duck 触发与诊断共用）；复用 noiseFilter 的 pcmRms，避免重复实现
    const frameRms = pcmRms(chunk)
    // 累计收帧诊断（每 50 帧一条，不受节流/pb 影响）：确认帧是否真的到达网关
    bargeFrames += 1
    if (frameRms > 0.008) bargeLoudFrames += 1
    if (bargeFrames % 50 === 0) {
      bargeDiag(`TOTAL frames=${bargeFrames} loud=${bargeLoudFrames} pb=${this.playbackPending}`)
    }
    // 帧一直会来，顺手把到期的回声抑制恢复掉
    if (this.halfDuplex && !this.echo.muted()) this.syncDuplex()
    // 软件 AEC：播报期把下发的 TTS 当参考，从这帧采集里减掉扬声器回声，只留真人插话。
    // 上面的 frameRms 用原始 chunk（要检测真人开口触发 duck），这里 VAD/ASR 用消除后的帧。
    // 没推过参考（非播报期）时 process 原样返回，零影响。
    //
    // 【2026-11-22 关键·长期保留】播报期全 0 静音帧跳过 AEC：
    // iOS 原生在播报期(_playRunning)上行一律全 0 帧（AppProductWakeModule.m:480，约 100 帧/秒），
    // 真人声根本不上行、只靠 KWS 原始帧打断。AEC.process 对每帧做 M=2048 阶 NLMS 卷积
    // （~200 万次浮点运算/帧 ×100 帧/秒 = 2 亿次/秒），全 0 帧（d=0）算出来只是 -dot，
    // 与全 0 同为静音、VAD 判定一致——跳过它数学上等价、零功能损失，却省掉最重的计算。
    // 这是 iOS 单进程事件循环被帧处理冲垮（HB-GAP 215s）的关键减负。
    // 【功能不缺失】真人插话帧(rms>=阈值)、非播报期帧、KWS 都完全不受影响：
    // 只跳过 rms≈0 的全 0 帧的 AEC，VAD.push/endpoint/ASR 门控全部照常执行。
    // 阈值收紧到 1e-6＝真正全 0 帧（iOS 上行全 0）；Android 真实静音帧 rms~0.0005 不会被跳过，
    // 保证 Android 的 AEC 滤波器 w 仍靠真实静音帧持续收敛、插话回声消除不受影响。
    const isAllSilentUplink = this.playbackPending && frameRms < 1e-6
    setDiagStage(isAllSilentUplink ? 'aec-skip-silent' : 'aec-process') // 【心跳埋点·长期保留】
    const cleanChunk = (this.aecActive && !isAllSilentUplink) ? this.aec.process(chunk) : chunk
    if (isAllSilentUplink) {
      silentAecSkipped += 1
      if (silentAecSkipped % 500 === 0) {
        bargeDiag(`AEC-SKIP-SILENT count=${silentAecSkipped} pb=true rms=${frameRms.toFixed(4)}`)
      }
    }
    setDiagStage('vad-push') // 【心跳埋点·长期保留】
    // VAD/ASR 用消除回声后的帧，与思考/空闲期同一套门槛，不加 strict。
    const vad = this.vad.push(cleanChunk)
    setDiagStage('frame-done') // 【心跳埋点·长期保留】
    // barge-in duck：播报期能量超过阈值（真人开口，非 TTS 底噪）就压低 TTS。
    // 不再依赖 vad.started——真人说话帧断续时 VAD 连续 2 帧门槛满足不了，started 几乎不触发。
    this.updateDuck(vad.voiced, frameRms > 0.02)
    // 临时诊断：播报期每 400ms 记一条能量/门槛/VAD 结论，定位「播报时插话识别不到」卡在哪
    const diagNow = Date.now()
    if (this.playbackPending && diagNow - bargeDiagAt >= 400) {
      bargeDiagAt = diagNow
      let sum = 0
      const n = Math.floor(chunk.byteLength / 2)
      const dview = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      for (let i = 0; i < n; i += 1) {
        const s = dview.getInt16(i * 2, true) / 32768
        sum += s * s
      }
      const rms = n ? Math.sqrt(sum / n) : 0
      bargeDiag(
        `FRAME pb=${this.playbackPending} rms=${rms.toFixed(4)} thr=${this.vad.threshold.toFixed(4)} `
        + `noise=${this.vad.noiseFloor.toFixed(4)} voiced=${vad.voiced} speech=${vad.speech} `
        + `frames=${vad.frames.length} half=${this.halfDuplex} echoMuted=${this.echo.muted()}`
      )
    }
    // 播报期 duck 且能量超阈值时，即使 VAD 因帧断续没确认 inSpeech（frames 为空），
    // 也把当前人声帧喂给 ASR——否则 ASR 只收到零碎帧+TTS 回声，识别成「滕王格式文字版」乱码。
    const forceFeed = this.playbackPending && this.ducked && frameRms > 0.02 && vad.frames.length === 0
    // 喂 ASR 的帧必须是 AEC 消除回声后的，否则等于把 TTS 回声送进识别
    const framesToFeed = forceFeed ? [cleanChunk] : vad.frames
    for (const frame of framesToFeed) {
      // forceFeed 是插话强喂（已用原始 frameRms>0.02 把关、且是 AEC 后帧），不过门控，
      // 否则误杀播报期插话。vad.frames（含 started 时的整段 preroll）逐帧过绝对下限，
      // 挡掉混进前缓冲的远场背景声/杂音——按用户原则"宁愿不出来也不要错"。
      if (!forceFeed && pcmRms(frame) < ABS_FLOOR_RMS) continue
      void this.asr.push(frame)
        .then((partial) => {
          // 临时诊断：记录每一条 ASR 返回的草稿原文与过滤决策
          if (this.playbackPending && partial) {
            const isN = isNoise(partial)
            const isF = isForeignNoise(partial, this.lang)
            const isEcho = this.playbackPending && resemblesSpoken(partial, this.spoken)
            bargeDiag(`PARTIAL text="${partial}" noise=${isN} foreign=${isF} echo=${isEcho}`)
          }
          // 实时草稿随识别下发：噪声幻觉碎片（The/Yeah 等纯英文虚词）不刷草稿；
          // 播报期间助手自己话被麦收回的回声草稿也不刷（resemblesSpoken 比对当前口播），
          // 但用户的插话草稿要照常下发——用户要求插话识别能显示出来、与「正在思考/正在播放」并存。
          if (
            partial &&
            !isNoise(partial) &&
            !isForeignNoise(partial, this.lang) &&
            !(this.playbackPending && resemblesSpoken(partial, this.spoken))
          ) {
            // 与定稿一致地去掉尾部重复词（「…怎么样？天气。」→「…怎么样？」），
            // 否则滚动草稿阶段就先闪一下多余的重复词，定稿又跳一下。
            this.deps.send({ type: 'asr.partial', text: stripTrailingEcho(partial) })
          }
        })
        .catch(() => undefined)
    }
    // 只有「AEC 消除回声后的真实人声」才重置句末计时：静音帧持续到达也会让计时器自然到期。
    // 播报期 forceFeed 用原始帧能量（含 TTS 回声）判断，只负责把帧强喂给 ASR 保识别率，
    // 绝不能用它重置 endpoint——TTS 一直播时回声让 frameRms 恒 >0.02、forceFeed 恒真，
    // endpoint 被每帧 clear 重设、永远凑不满静音窗口 → 定稿拖到播报结束、期间多次插话被
    // 合并成一句（用户 2026-11-19 真机实锤：「播完才进队列」「插话和之前的合并」）。
    // 空闲期没有回声问题，forceFeed 仍可作为兜底重置（理论上空闲期 forceFeed 恒 false）。
    if (vad.voiced || (!this.playbackPending && forceFeed)) this.armEndpoint()
  }

  /** 半双工状态只在切换时下发一次，避免每帧都刷事件。 */
  private syncDuplex(): void {
    const half = this.echo.muted()
    if (half === this.halfDuplex) return
    this.halfDuplex = half
    this.deps.send({ type: 'audio.duplex', mode: half ? 'half' : 'full' })
  }

  /**
   * barge-in duck：播报期检测到真人声能量（rms>阈值）时压低 TTS，让麦克风只收到人声、
   * ASR 识别准；用户说完后自动恢复。这是「播报插话识别成乱码」的治本——
   * 真机诊断：播放音乐时插话顺（音乐 duck 到 0.1），TTS 播报满音量时回声把插话搅成乱码。
   * 不用 vad.started：真人说话帧断续时 VAD 连续 2 帧门槛满足不了，started 几乎不触发。
   * @param voiced 本帧 VAD 是否有人声（含尾音保留）
   * @param energyHit 本帧能量是否超过「真人开口」阈值
   */
  private updateDuck(voiced: boolean, energyHit: boolean): void {
    if (!this.playbackPending) {
      // 不在播报期：若还 duck 着就恢复（兜底，正常由播放结束路径恢复）
      if (this.ducked) this.setDuck(false)
      return
    }
    // 真人开口（能量超阈值）：立刻 duck
    if (energyHit && !this.ducked) this.setDuck(true)
    // 还在说话（能量或 VAD 有人声）：续期释放定时器
    if (this.ducked && (energyHit || voiced)) {
      if (this.duckReleaseTimer) clearTimeout(this.duckReleaseTimer)
      this.duckReleaseTimer = setTimeout(() => {
        this.duckReleaseTimer = null
        this.setDuck(false)
      }, 1500)
    }
  }

  private setDuck(duck: boolean): void {
    if (duck === this.ducked) return
    this.ducked = duck
    // 播报期真人开口：记住这句是"插话"，供定稿时判断入队（即使那时光播报已结束）
    if (duck && this.playbackPending) this.bargeInDuringPlayback = true
    bargeDiag(`DUCK duck=${duck}`)
    this.deps.send({ type: 'audio.duck', duck })
  }

  private armEndpoint(): void {
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    // 句末静音等待统一用 asrEndpointMs（默认 2500ms）。
    // 曾经播报期压到 1000ms 是为对抗「播完才进队列」的妥协，但那个真因其实是
    // finalizeUtterance 里直连命令 await 播报占死链（已修），与 endpoint 时长无关；
    // 而 1000ms 太短——中文说话中途停顿常 >1s，导致「还没说完就定稿」「插话被切成多句」
    // （用户 2026-11-19 反馈）。真因修复后入队不再被阻塞，这里放宽到和空闲一致即可。
    // 绝不加「开口后 N 秒强制定稿」硬上限——长句 >N 秒会被截断。真人说话的 vad.voiced
    // 会自然续期，说完（静音）后 wait 到期即定稿；回声续期由 armEndpoint 触发条件解决
    // （播报期只认 AEC 后真实人声，见 handleBinary）。
    const wait = this.deps.asrEndpointMs
    this.endpointTimer = setTimeout(() => {
      // 串行而非丢弃：上一句还没交给大模型时，下一句也必须在链里排队等
      this.finalizeChain = this.finalizeChain
        .then(() => this.finalizeUtterance())
        .catch(() => undefined)
    }, wait)
  }

  /** 上次「识别失败」提示时间：30s 节流，避免连环失败时提示音刷屏。 */
  private lastAsrFailNoticeAt = 0

  /** ASR 上游出错/超时的兜底提示：下发 asr-error 提示音（客户端本地播「没听清，再说一遍」）。 */
  private notifyAsrFailed(): void {
    // 待唤醒态（wake）用户还没开口对话，ASR 失败不该反复播「没听清，请重新说一遍」打扰用户。
    // P1 接入端侧 KWS 后 wake 态不再调 ASR，这条路径自然消失；当前先挡住误播。
    if (this.mode === 'wake') return
    const now = Date.now()
    bargeDiag(`ASR-FAIL-CUE throttled=${now - this.lastAsrFailNoticeAt < 30_000} pb=${this.playbackPending} proc=${this.processing} queue=${this.queue.length}`)
    if (now - this.lastAsrFailNoticeAt < 30_000) return
    this.lastAsrFailNoticeAt = now
    this.deps.send({ type: 'client.cue', cue: 'asr-error' })
  }

  /**
   * 幻觉二级判断（配合 9529 的 Silero VAD）：VAD 说这段「真人语音极短」(<0.6s) 时，
   * 若文本既不是已知有效意图、也不是真人会用的单字实义/选号，就当噪声丢弃。
   *
   * 为什么需要它：声学上打嗝/吸鼻子和真人说「嗯/好」完全重叠（实测 ZCR/能量/时长都分不开），
   * 单靠声学门控要么漏幻觉、要么误杀真人。VAD 提供「说了多久真语音」这个可靠信号，
   * 再用「是否有效意图」做语义兜底——用的是业务本就要维护的意图识别（白名单），
   * 不是为噪声堆字黑名单，真人任何正常指令都不误伤。
   */
  private isHallucinationShort(text: string, speechDuration: number, hasSelectionContext = false): boolean {
    // skill 意图判断走各 skill 的 matchesIntent；确保实例已构造（正常在 start 里，此处兜底幂等）。
    this.ensureSkills()
    if (!Number.isFinite(speechDuration) || speechDuration < 0 || speechDuration >= 0.6) return false
    const t = text.trim()
    // 多字句一律放行：真人正常说话/选号（第二首）都是多字，打嗝幻觉是单字或纯数字。
    // 注意纯数字单独处理（见下）——「8」既可能是选号也可能是打嗝幻觉，靠上下文区分。
    if (Array.from(t).length > 1 && !/^\d+$/.test(t)) return false
    // 命中任何已知有效意图 → 放行。内容/商品 skill（音乐/时间/天气/百科/诗词/新闻/好价等）走各 skill 的
    // matchesIntent（网关不 import 具体 skill）；剩余通用控制（音量/字幕/记忆/播放模式）保留其 detect。
    if (
      this.skills.some((s) => s.matchesIntent?.(t)) ||
      detectVolumeCommand(t) || detectSubtitleCommand(t) ||
      detectPlayModeCommand(t)
    ) return false
    // 纯数字选号：只有在「刚给过候选列表/编号列表」的上下文里才是有效输入；
    // 否则单字数字（8/9）和打嗝/吸鼻子幻觉文本相同，短语音一律当幻觉拦。
    if (/^\d+$/.test(t)) return !hasSelectionContext
    // 真人会用的单字实义/应答 → 放行（好/停/是/对/走/滚…）
    if (EFFECTIVE_SHORT_WORDS.has(t)) return false
    // 短语音 + 既非有效意图、也非真人应答 → 幻觉（打嗝→我/你、吸鼻子→8、回声碎片）
    return true
  }

  private async finalizeUtterance(): Promise<void> {
    // 打断/关闭后串行链里可能还挂着定稿，不能让它再发 asr.final 或排队
    if (!this.active || this.cancelled) return
    // 只有确认用户说完了（静音够久）才定稿；中间结果从不触发回复
    let text: string
    try {
      text = await this.asr.finalize()
    } catch {
      // ASR 上游出错/超时：不能静默吞掉让用户以为卡死（用户要求有兜底、有提示）。
      // 节流下发 asr-error 提示音（客户端本地 mp3「没听清，再说一遍」），30s 内不重复。
      this.notifyAsrFailed()
      return
    }
    // 取出并清除"播报期插话"标志：定稿后无论走哪条分支都不该污染下一句
    const bargeIn = this.bargeInDuringPlayback
    this.bargeInDuringPlayback = false
    if (!this.active || this.cancelled) return
    // 环境杂音被 ASR 误识别出的伪文本、以及播报被收回的回声，都静默丢弃，
    // 不进模型也不进队列，避免凭空多出一轮回答和 TTS。
    // isNoise 已覆盖 SenseVoice 对静音/音乐回声稳定冒出的英文虚词碎片（The/Yeah/oh…），
    // 这类碎片进 LLM 会胡乱追问「你说的The没听清」。按会话语言脚本过滤会误伤英文歌名
    // （Taylor Swift）和混排，故只在「极短纯拉丁虚词」层面拦，不按语言。
    // 去掉 SenseVoice 在句尾多吐的重复词（实机「今天天气怎么样？天气。」→「今天天气怎么样？」）：
    // 必须在所有下游分支（回声比对/队列/直连/LLM/asr.final）之前清洗，保证「我说」框与模型
    // 看到的是同一份干净文本。诊断同时记录 raw 原文，便于追溯 ASR 的原始输出。
    const rawText = text
    text = stripTrailingEcho(text)
    // ASR 同音错字当场纠（周杰轮→周杰伦、滕王格世→滕王阁序），让「我说」框显示正确文字，
    // 错字停在当轮、不流到下游意图识别/LLM。确定性零误纠，纠不动的原样保留。
    const corrected = (this.deps.asrCorrect ?? ((t: string) => getDefaultAsrCorrector().correct(t)))(text)
    if (corrected !== text) {
      bargeDiag(`ASR-CORRECT "${text}" → "${corrected}"`)
      text = corrected
    }
    // 临时诊断：定稿文本 + 噪声过滤结果，确认 endpoint 有没有触发、文本有没有被丢
    bargeDiag(
      `FINAL text="${text}"${text !== rawText ? ` raw="${rawText}"` : ''} pb=${this.playbackPending} noise=${isNoise(text)} `
      + `foreign=${isForeignNoise(text, this.lang)} echo=${Date.now() < this.echoUntil && resemblesSpoken(text, this.spoken)}`
      + ` vd=${this.asr.speechDuration ?? -1}`
    )
    if (!text || isNoise(text) || isForeignNoise(text, this.lang)) return

    // VAD 幻觉二级判断：短语音 + 无有效意图 → 噪声丢弃（打嗝/吸鼻子/回声脑补的单字）。
    // 内置 SenseVoice 才有 speechDuration；上游 ASR（-1）跳过此判断，行为不变。
    if (this.isHallucinationShort(text, this.asr.speechDuration ?? -1, !!(this.content.hasPendingCandidates() || this.anySkillHasCandidates()))) {
      bargeDiag(`HALLUCINATION-DROP text="${text}" vd=${this.asr.speechDuration}`)
      return
    }

    // ── skill 定稿钩子（偏好追问等规则已迁进 skill）──
    // 只在空闲真实对话轮次处理（播报期插话的「好/嗯」会排队，由 runTurn 消费时再确认）。
    // 任一 skill 的 onFinalize 消费了这句就直接 return，不再走直连命令 / LLM。
    if (!this.playbackPending && !this.processing) {
      if (await this.dispatchFinalize(text)) return
    }

    // 上一轮给过候选歌曲列表，这一句优先当作「选第几首 / 说歌名」解析。
    // 必须在下面的回声比对之前：用户说的「第二首」「稻香」正是刚口播过的词，
    // 否则会被 resemblesSpoken 当成播报回声丢掉，导致永远选不中。
    if (this.content.hasPendingCandidates() && await this.content.selectCandidate(text)) return
    // 上一轮给过商品编号列表，这一句优先当作「说编号 / 点商品名」解析。
    // 同样必须早于回声比对：「第二个」正是刚口播过的词。
    if (await this.dispatchCandidateSelection(text)) return

    // 上一轮「换一首」没找到同类型的其它歌，正等确认是否换其它风格（委托内容执行器）。
    if (await this.content.consumeNextFallback(text)) return

    // 播报（TTS）进行中：不放行成新轮次，但插话要排队——与思考阶段一致，
    // 当前句播完（或被「小熊小熊」跳过后）由 runTurn 依次消费。
    // 唤醒词识别靠 asr.queued/asr.rejected 把识别文本透传回客户端做「小熊小熊」比对：
    // 命中则客户端发 session.skip_current 跳当前句（招呼由客户端本地播），网关据 dropText
    // 把这句唤醒词从队列移除。助手自己刚念过的原话（回声）静默丢弃，且此分支不触发
    // 回声兜底静音，否则会连用户想用来打断的唤醒词一起掐掉。
    // 入队条件：播报进行中，或"这句是播报期开的口"（定稿可能拖到播报结束后、pb 已 false）。
    // bargeIn 在 setDuck(true) 且播报期时置位，定稿时已取出并清字段。
    if (this.playbackPending || bargeIn) {
      if (Date.now() < this.echoUntil && resemblesSpoken(text, this.spoken)) return
      this.enqueueDuringBusy(text)
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

    // 当前轮还没跑完（未在应答 / 思考中）：不打断、不消费，仅把这句排进队列；
    // 排队句会在本轮播完后由 runTurn 回放，并同样走下面的直连拦截，
    // 避免被丢给大模型由 skill 提示引导大模型播放（破坏「按歌手浏览要给候选列表让用户选」）。
    if (this.processing) {
      this.enqueueDuringBusy(text)
      return
    }

    // 空闲：音乐/音量/记忆等意图明确的指令直连拦截，确定性落地，绕开大模型
    // （避免模型幻觉「说播放却没播放 / 说调音量却没调」）。没有音乐源时不拦截音乐类。
    // 这里统一下发一次 asr.final（「我说」卡片数据源）。
    //
    // ⚠️ 绝不在这里 `await handleDirectCommand(text)`：天气/时间/百科等直连命令内部
    // `await speakReply`，而 speakReply 在 processing=false 时会 `await playback` 死等
    // 整段播报（几十秒）→ finalizeUtterance 卡住 → finalizeChain 一直 busy → 播报期所有
    // 插话定稿排队饿死，直到播报播完才集中定稿＝「播完才进队列」（2026-11-19 埋点铁证）。
    // 改为首句也统一走 runTurn：runTurn 内 processing=true，speakReply 走「不 await playback」
    // 分支，播放等待由 runTurn 自己的 await playback 统一管理；runTurn 内也会再拦一次直连
    // 命令（幂等，见 runTurn 里的注释）。这样 finalizeChain 在下发后立刻释放，插话能及时定稿。
    this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
    void this.runTurn(text)
  }

  /**
   * 当前轮还没跑完（思考 / 播报）时把这句排进队列，并把识别原文经 asr.queued 透传回客户端：
   * 客户端据此更新「我说」右上角的排队数，并对 text 做「小熊小熊」匹配——命中就发
   * session.skip_current 跳过当前句（招呼由客户端本地播），网关据 dropText 把这句唤醒词移除。
   * 队列满时不入队，但仍发 asr.rejected（带 text）：让客户端在队列满时也能识别唤醒词打断，
   * 而不是把唤醒词连同拒收一起吞掉。
   */
  private enqueueDuringBusy(text: string): void {
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
    // 插话定稿若恰好落在 runTurn 退出之后（此刻 while 已因「shift 到空」break、
    // processing=false、finally 兜底也已执行完），队列项就没人消费——必须主动 kick。
    this.kickQueueWhenIdle()
  }

  /**
   * 无 runTurn 在跑时主动 kick 一轮消费队首。播报期插话「定稿晚于播报结束」时，队列会在
   * runTurn 退出后才被填入，runTurn 的 while 与 finally 兜底都赶不上——必须在这里补一刀。
   * 入队路径与 runTurn finally 的兜底共用本入口：processing 检查放在 shift 之前，谁先把
   * processing 置真谁负责消费，另一个直接返回，杜绝「两路 kick 各 shift 一句、其中一句
   * 因 processing 已真被 runTurn 开头 return 丢弃」的竞态。
   */
  private kickQueueWhenIdle(): void {
    if (!this.active || this.cancelled || this.processing || this.queue.length === 0) return
    const next = this.queue.shift()
    if (!next) return
    bargeDiag(`QUEUE-KICK runTurn text="${next}" remain=${this.queue.length}`)
    // 这条路径不经过 runTurn 的 while 顶部（那句 asr.final 在 runTurn 外部），
    // 这里补发让「你说」卡片切到这句插话，与正常 shift 路径一致。
    this.deps.send({ type: 'asr.final', text: next, queueRemaining: this.queue.length, fromQueue: true })
    void this.runTurn(next)
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
        // 新的一句开始：清除上一句可能的「跳过当前」标志。
        // 必须在 armPlaybackWait 之前复位，否则被跳过的当前句会让下一句也被误停。
        this.skipRequested = false
        // 每一句的播报内容与上一句无关，清空回声比对样本
        this.spoken.length = 0
        this.downlinkBytes = 0
        // 先建好等待再开播：客户端可能在音频下发完之前就回执播完
        const playback = this.armPlaybackWait()
        let ttsStarted = false
        let directHandled = false
        try {
          this.deps.data.insertCommandLog(this.deviceId, current, 'pending')
          // 排队回放的句子先过 skill 定稿钩子：播报期问「要不要记」后用户的「好」排到这里，
          // 由 preference skill 此时才真正落库（finalizeUtterance 里 pb=true 不处理确认）；
          // 播报期插话的偏好句也在这里补 stage，runAgent 才能把追问拼进同一段 TTS。
          if (await this.dispatchFinalize(current)) {
            directHandled = true
          } else {
            // 排队回放的句子也要走直连拦截（音乐/音量/记忆），不能丢给大模型自动播放；
            // 首句已由 finalizeUtterance 拦过，这里再拦一次是幂等的（非指令会返回 false）。
            directHandled = await this.handleDirectCommand(current)
          }
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
        } else this.cancelPlaybackWait('turn-no-tts')
        if (this.turn !== turn || this.cancelled) break
        // 一句播完后的 skill 兜底钩子（preference skill 在这里兜底追问「要不要记」；
        // 主路径是同链追问 onAgentReply，这里 asked 已 true 时自然 no-op）。
        await this.dispatchAfterSpeak(current)
        if (this.turn !== turn || this.cancelled) break
        // 真实对话轮次（非直连命令）结束后，异步抽取并沉淀长期记忆；直连命令（音乐/音量/记忆等）
        // 不进抽取，避免把「放首歌」「清空记忆」这类指令本身当成偏好记下来。
        if (!directHandled) {
          this.pushUserTurn(current)
          void this.runAutoMemory()
        }
        const next = this.queue.shift()
        if (!next) break
        // 让客户端把界面切到这句，并同步权威剩余数（客户端不靠 ±1 猜测）
        this.deps.send({ type: 'asr.final', text: next, queueRemaining: this.queue.length, fromQueue: true })
        current = next
      }
    } finally {
      this.processing = false
      // 整轮播报结束：停掉软件 AEC，避免空闲期用残留的旧 TTS 参考误消环境声/下一句人声。
      if (this.aecActive) { this.aec.reset(); this.aecActive = false }
      // 队列卡死兜底（真机铁证：skip/break/await playback 提前退出后，队列还剩句子却无人消费，
      // 界面停在「已完成」但队列有内容不动）：会话仍 active、未被取消、且队列非空时，
      // 主动 kick 一轮消费队首。用 setTimeout(0) 异步调度，避免在本轮 finally 内重入。
      // 与 enqueueDuringBusy 的补刀共用 kickQueueWhenIdle（processing 检查在 shift 之前），
      // 两路不会重复消费、也不会把 shift 出的句子丢给一个正在跑的 runTurn。
      if (this.active && !this.cancelled && this.queue.length > 0) {
        setTimeout(() => this.kickQueueWhenIdle(), 0)
      } else if (this.active && !this.cancelled && this.queue.length === 0) {
        // 队列已全部消费完：通知客户端清掉排队角标。否则插话进队列后、最后一句播完，
        // 前端 queuePending 卡在最后值不再归零（「队列没出」真机现象）。
        this.deps.send({ type: 'queue.drained' })
      }
    }
  }

  /** 先建好「等播完」的 Promise，再开始下发，避免回执早于等待而丢失。 */
  private armPlaybackWait(): Promise<void> {
    this.cancelPlaybackWait('arm-new-window')
    // 新播放窗口：重置 tts.idle 幂等标志（每句各自收尾一次）
    this.ttsIdleSentForTurn = false
    return new Promise<void>((resolve) => {
      const done = (fallback: boolean) => {
        // 【关键日志·长期保留】播放等待处结：fallback=true 表示 timer 自然到期（回执丢了），
        // false 表示回执到达/主动取消。必须能区分，禁止定位后删除。
        bargeDiag(`PB-WAIT-DONE fallback=${fallback} turn=${this.turn} downlink=${this.downlinkBytes}`)
        if (this.playbackTimer) clearTimeout(this.playbackTimer)
        this.playbackTimer = null
        this.playbackResolve = null
        // 播完（或超时）后关闭回声门控窗口，并恢复 duck 的播报音量（兜底）
        this.playbackPending = false
        if (this.duckReleaseTimer) {
          clearTimeout(this.duckReleaseTimer)
          this.duckReleaseTimer = null
        }
        this.setDuck(false)
        // 计时器自然到期（回执可能丢失）：补发一次 tts.idle，避免前端卡「正在播报」直到 watchdog。
        // 原生回执正常到达时走不到这（timer 已被 resolvePlayback 清掉），对 Android 零影响。
        if (fallback) this.emitTtsIdle('playback-timeout')
        resolve()
      }
      this.playbackResolve = done
      // 用固定上限兜底，客户端没回执也不会把队列卡死；
      // 下发完音频后会按实际时长收紧。
      this.playbackTimer = setTimeout(() => done(true), 30_000)
    })
  }

  /** 分批流水线播报：把 playback 兜底等待延长到覆盖整轮，避免早期批次时 30s 兜底就到期
   *  提前 resolve await playback → 会话退下掐掉剩余批次。按总字数估算整轮时长（~0.3s/字）+余量。 */
  private deferPlaybackWaitForChunks(totalChars: number): void {
    if (!this.playbackTimer || !this.playbackResolve) return
    clearTimeout(this.playbackTimer)
    const ms = Math.max(30_000, totalChars * 320 + 10_000)
    const done = this.playbackResolve
    this.playbackTimer = setTimeout(() => {
      this.playbackPending = false
      this.playbackTimer = null
      this.playbackResolve = null
      this.setDuck(false)
      // 长播报整轮兜底计时器到期：回执大概率丢了，补发 tts.idle（幂等）
      done(true)
    }, ms)
  }

  /** 按本窗口已下发的音频字节估算播完时长（24kHz/16bit/mono=48000 字节/秒=48 字节/ms）。
   *  随 tts.end 下发给客户端设「精确收尾 timer」，专治 iOS 网关 DATA_STALL 时 tts.idle
   *  下发不出来、客户端干等 60s watchdog 导致「唤醒后只能聊一次」。tts.idle 正常到达
   *  客户端会清掉该 timer，故对 Android（回执正常）零影响。留 1.5s 余量覆盖句尾。 */
  private estimatedSpeechMs(): number {
    return Math.round((this.downlinkBytes / 48) + 1500)
  }

  /** 音频下发完后按实际时长收紧超时，避免客户端断线时白等 30 秒。 */
  private tightenPlaybackTimeout(): void {
    const resolve = this.playbackResolve
    if (!resolve) return
    if (this.playbackTimer) clearTimeout(this.playbackTimer)
    // 24kHz/16bit/mono = 48000 字节/秒，再留 1.5 秒余量
    const estimatedMs = (this.downlinkBytes / 48000) * 1000 + 1500
    const waitMs = Math.max(2000, estimatedMs)
    bargeDiag(`PB-WAIT-ARM turn=${this.turn} downlink=${this.downlinkBytes} estimateMs=${waitMs}`)
    // 这是最准的「应该已播完」时刻：回执到这里还没来基本可判定丢失，补发 tts.idle（幂等）。
    // Android 回执远早于此时到达、timer 已被清，走不到这里。
    this.playbackTimer = setTimeout(() => resolve(true), waitMs)
  }

  private cancelPlaybackWait(source = '?'): void {
    // 【关键日志·长期保留】记录谁清掉了 playback 兜底 timer。iOS 真机曾出现
    // 25s playback-timeout 兜底未触发、回执晚 212s，怀疑 timer 被某条路径 clear。
    // 只有看到这条日志才知道是哪个调用点清的，禁止定位后删除。
    bargeDiag(`PB-TIMER-CLEAR cancel source=${source} hadTimer=${!!this.playbackTimer} turn=${this.turn}`)
    if (this.playbackTimer) clearTimeout(this.playbackTimer)
    this.playbackTimer = null
    // 让正在 await 的链立刻解除阻塞，链随后会检查 cancelled 自行退出
    // 传 false：主动取消绝非「播完」，不能补发 tts.idle
    this.playbackResolve?.(false)
    this.playbackResolve = null
  }

  // 【2026-11-22】原 scheduleAuthoritativeTtsIdle 已删除：tts.idle 统一由 playback_done 发，
  // 覆盖所有播报路径（runAgent + speakReply 直出），不再用只覆盖 runAgent 的定时器。

  private resolvePlayback(source = '?'): void {
    // 【关键日志·长期保留】记录谁解除了播放等待。回执到达、TTS 失败、打断都会走这里，
    // done(false) 内部会清 timer；必须能追溯，禁止定位后删除。
    bargeDiag(`PB-TIMER-CLEAR resolve source=${source} hasResolve=${!!this.playbackResolve} turn=${this.turn}`)
    // 传 false：这是「回执到了」触发的解除等待，tts.idle 由调用方走 emitTtsIdle 统一发。
    // TTS 失败路径也调它解除等待，那些路径本就不该发 tts.idle。
    this.playbackResolve?.(false)
  }

  /**
   * 幂等下发 tts.idle：一个播放窗口（armPlaybackWait 之间）只发一次。
   * 两个出口共用：原生 playback_done 回执（pcm-done）+ 播放计时器到期兜底（playback-timeout）。
   * Android 回执正常时走 pcm-done 置位，兜底计时器已被 clear、永不触发——行为与改动前一致。
   */
  private emitTtsIdle(source: string): void {
    if (this.ttsIdleSentForTurn) {
      bargeDiag(`TTS-IDLE SKIP already-sent source=${source}`)
      return
    }
    this.ttsIdleSentForTurn = true
    bargeDiag(`TTS-IDLE SEND source=${source} pb=${this.playbackPending}`)
    this.deps.send({ type: 'tts.idle' })
  }

  /**
   * 边生成边合成：LLM 流式出字，遇到句末标点就把这句立刻交给 TTS，
   * 让首声在 LLM 还没生成完时就响，显著降低语音延迟。
   * turn 用于识别「这一轮已被打断」：旧轮的所有下发都要停。
   */
  /** @returns 是否发出过 tts.start（决定要不要等播放完成回执） */
  private async runAgent(text: string, turn: number): Promise<boolean> {
    if (!this.agent) return false
    // skipRequested 也视为「当前句已作废」：停止后续 delta 下发与 enqueue，
    // 但不清队列、不 ++turn，runTurn 的链得以继续播队首下一句。
    const stale = () => this.turn !== turn || this.cancelled || this.skipRequested
    let buffer = ''
    let ttsStarted = false
    let ttsChain: Promise<void> = Promise.resolve()
    let timedOut = false
    // LLM 自由回答不设字数上限：界面显示与播报都完整输出。
    // 曾有个 100 字闸门（emittedChars/lengthCapped），超限就停发 llm.delta + enqueue——
    // 导致"总结十大瞬间"只列前几个、界面和播报都被砍。按用户要求移除，字数交给系统提示词
    // 的"言简意赅但要列全"约束，不再在代码里硬截断。
    // 【2026-11-22 原则：边合成边读，绝不一次合成整段】
    // 9529 TTS 接口非流式（整段合成完才返回 WAV），"流式"只能在网关侧做：
    // 把断句攒成适中大小的批（TTS_CHUNK_CHARS≈75字），每批一次 synthesize，批间流水线。
    // 为什么不能逐句：sentenceCut 在逗号就切，430字回答切成 36 个 8-20 字碎片，每片播 3-5s、
    //   合成下一片却要 3-8s → 合成追不上播放 → 空档 → 原生播空误判 → "没播完状态就变了"。
    // 为什么不能整段：300+ 字一次 synthesize 实测 42s 超时 → "这段没能播报"。
    // 折中：~75字/批，合成~12s < 播放~15s，流水线跟得上、无空档；批数从 36 降到 ~6。
    const TTS_CHUNK_CHARS = 75
    const pendingSentences: string[] = []
    const enqueue = (sentence: string) => {
      const clean = sanitizeForSpeech(sentence)
      if (!clean) return
      pendingSentences.push(clean)
      bargeDiag(`TTS-ENQ len=${clean.length} text="${clean.slice(0, 24)}"`)
    }
    /** 把短句攒成 ~75 字的批，每批一次合成，批间串成流水线。 */
    const buildChunks = (): string[] => {
      const chunks: string[] = []
      let cur = ''
      for (const s of pendingSentences) {
        if (cur && cur.length + s.length > TTS_CHUNK_CHARS) {
          chunks.push(cur)
          cur = ''
        }
        cur += s
      }
      if (cur) chunks.push(cur)
      return chunks
    }
    /** LLM 输出结束后，分批合成并串成流水线：合成下一批时上一批正在播放。 */
    const flushTts = (): void => {
      const chunks = buildChunks()
      if (!chunks.length) return
      ttsStarted = true
      this.speaking = true
      this.playbackPending = true
      this.deps.send({ type: 'tts.start', format: 'pcm16', sampleRate: 24000 })
      // 延长 playback 兜底等待覆盖整轮分批（否则 armPlaybackWait 的 30s 兜底在早期批次就到期，
      // 提前 resolve await playback → 退下掐掉剩余批次）。整轮下发完后 tighten 会再按实际时长收紧。
      const totalChars = chunks.reduce((n, c) => n + c.length, 0)
      this.deferPlaybackWaitForChunks(totalChars)
      bargeDiag(`TTS-SENTENCES sentences=${pendingSentences.length} chunks=${chunks.length} chars=${totalChars}`)
      // 批次串行：speakSentence 合成一批并下发全部帧后返回；下一批紧接着合成。
      // App 端 role=pcm 边收边播，合成快于播放时音频连续、句间无停顿。
      let chain: Promise<void> = Promise.resolve()
      for (const chunk of chunks) {
        chain = chain.then(() => {
          if (stale()) return
          bargeDiag(`TTS-SYNTH len=${chunk.length} text="${chunk.slice(0, 20)}"`)
          return this.speakSentence(chunk, turn)
        })
      }
      ttsChain = chain
    }
    // 超时看门狗：上游 LLM 卡住/冷启动慢时，主动舍弃本轮流式增量、断开下行播放，
    // 立即播友好兜底，不让用户干等、也不暴露技术故障（用户：「不要让用户觉得好慢」）。
    // 【空闲超时，不是总时长超时】每次收到正文/思考增量都把计时器续期——只要模型还在吐字就
    // 一直等。真机铁证：原实现是「整轮 15s 总超时」，"总结科比十大瞬间"这类长回答生成本身
    // 就要 16s+，到点被砍 → 播 llm-error、一个字都不说（14:58:37 收到识别、14:58:53 报错）。
    // 首包另给宽限：think 开启时推理模型首 token 可能要 60~90s（实测复杂问题 88s），
    // 故首个增量前用 THINK_LLM_TIMEOUT_MS(120s)；未开启思考仍用短超时快速兜底。
    const thinkEnabled = this.lastVoice?.params?.think === true
    const idleMs = this.deps.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
    const firstMs = this.deps.llmTimeoutMs ?? (thinkEnabled ? THINK_LLM_TIMEOUT_MS : DEFAULT_LLM_TIMEOUT_MS)
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    let rejectTimeout: ((err: Error) => void) | null = null
    /** 重新计时：首包前用 firstMs，开始吐字后每次增量都按 idleMs 续期 */
    const armLlmTimeout = (ms: number) => {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      timeoutTimer = setTimeout(() => rejectTimeout?.(new Error('LLM_TIMEOUT')), ms)
    }
    /** 有增量就续期（思考帧也算：思考期模型确实在工作，不能当卡死） */
    const bumpLlmTimeout = () => armLlmTimeout(idleMs)
    const replyPromise = this.agent.reply(
      text,
      (delta) => {
        if (stale() || timedOut) return
        bumpLlmTimeout()
        // 无字数闸门：llm.delta 全量下发，界面与播报都完整。
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
        if (stale() || timedOut) return
        bumpLlmTimeout()
        this.deps.send({ type: 'llm.thinking', text: delta })
      }
    )
    // 超时后 replyPromise 仍在跑：挂个空 catch 避免产生未处理 rejection
    void replyPromise.catch(() => undefined)
    try {
      const full = await Promise.race([
        replyPromise,
        new Promise<string>((_, reject) => {
          rejectTimeout = reject
          armLlmTimeout(firstMs)
        }),
      ])
      if (stale()) {
        this.deps.data.insertCommandLog(this.deviceId, text, 'cancelled')
        return ttsStarted
      }
      // LLM 回复自动学习：用 learnFromAnchors 从识别原文取用户词、从 LLM 回复里按锚点
      // （《》/播放：）取规范词，再交规则链判学。比旧的滑动窗口 learnFromTexts 更准，
      // 且 homophone/source-correction 规则都有公共子串≥2护栏，不再误学"神父→神赋"。
      if (this.deps.correctionSyncer) {
        void this.deps.correctionSyncer.learnFromAnchors(text, full, { source: 'llm' })
      }
      enqueue(buffer)
      buffer = ''
      // skill 追问：把「要我帮你记下来吗？」等拼进同一条 TTS 链，和回答连续播——
      // 不再等播完回执后单独 speakReply（那样中间有 tts.end→tts.start 停顿，
      // 用户体感「播报停了、突然冒出一段」）。preference skill 的 onAgentReply 在这里
      // 置 asked=true 建立确认上下文。
      const appendTts = this.dispatchAgentReply(text, full)
      if (appendTts) {
        this.deps.send({ type: 'llm.delta', text: appendTts })
        enqueue(appendTts)
      }
      this.deps.data.insertCommandLog(this.deviceId, text, full.slice(0, 200))
      // 分批流水线合成下发。ttsDispatching 在整链下发完前保持 true，期间原生批次间隙的
      // playback_done 一律忽略（不当整轮播完），避免前端提前收尾/退下掐掉剩余批次。
      // 【关键顺序】必须先 flushTts（内部发 tts.start）再发 llm.done：前端 llm.done 处理里
      // `if(!answerHasTts) markAnswerDone()` 会启动 T1(30s) 静默计时；tts.start 到达才置
      // answerHasTts=true。若 llm.done 先到，T1 就开始跑，长播报超 30s → T1→T2→standby→
      // cancelled → 掐断剩余批次（真机铁证：847字/13批播报在第5批、距 tts.start 47s≈30+15 断）。
      // 换成 tts.start 先到后，llm.done 时 answerHasTts 已 true，不再 markAnswerDone/T1。
      flushTts()
      this.deps.send({ type: 'llm.done' })
      if (ttsStarted) this.ttsDispatching = true
      await ttsChain
      this.ttsDispatching = false
      if (ttsStarted && !stale()) {
        this.speaking = false
        // 所有批次音频已下发完毕、进入「等原生播空回执」阶段；downlinkBytes 用于估算应播完时刻。
        // 若之后既无 PB-DONE、也无 playback-timeout 兜底日志，说明 merge 卡在这之后。
        bargeDiag(`TTS-ALL-SENT turn=${this.turn} downlink=${this.downlinkBytes} -> await playback_done`)
        this.deps.send({ type: 'tts.end', durationMs: this.estimatedSpeechMs() })
        // tts.idle 由 playback_done（原生播空回执）统一发，覆盖所有播报路径。
      } else if (!ttsStarted && !stale()) {
        // 整句都不可念（大模型泄漏的控制符 / 空回复 / 只剩符号）：绝不当作正文念出来，
        // 给一句兜底口播，让人能自然重说一遍。兜底句有 TTS 下发，返回 true 让 runTurn
        // 等它播完回执再 shift 队列下一句。
        await this.speakReply(messages(this.lang).llmFallthrough())
        return true
      }
      return ttsStarted
    } catch {
      this.ttsDispatching = false
      if (stale()) return ttsStarted
      // 超时或任何 LLM 异常：主动舍弃本轮、断开下行、给友好兜底，不 sendError 技术错误。
      // 不 cancelPlaybackWait：兜底口播仍由 runTurn 的 await playback 等它真正播完——
      // 若提前解除，下一句会在兜底句还在播时下发，被客户端 isSpeaking 抗重复挡掉而无声，
      // asr.final 也被挡导致排队角标不动（「排队卡死」的完整因果链，2026-11-16 实锤）。
      timedOut = true
      if (ttsStarted) this.deps.send({ type: 'tts.stop' })
      this.speaking = false
      this.playbackPending = false
      // LLM 失败兜底改用本地 mp3 提示音，不再用 TTS 念 llmUnavailable 文本——
      // TTS 本身可能也坏了，用 TTS 兜底等于没有兜底。mp3 打包在客户端、不依赖网关/TTS。
      this.deps.send({ type: 'client.cue', cue: 'llm-error' })
      // 没有 llm.done 前端会停在 thinking 态，补发一个让界面收尾（LLM_ERROR 路径不发）
      this.deps.send({ type: 'llm.done' })
      // 返回 false：本轮没产生 TTS 播报，runTurn 会 cancelPlaybackWait 立即推进队列下一条。
      return false
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
    }
  }

  /**
   * 下发一句 TTS：流式合成逐帧转发。带帧间看门狗——上游（builtin / dashscope ws）挂起
   * 不产帧也不报错时，`await ttsChain` 会永久挂起且在 LLM 超时看门狗覆盖之外，整链死锁、
   * 队列再没人消费（用户要求「TTS 也要超时兜底，不能卡死对话」）。流式合成帧间隔为毫秒级，
   * 帧间超时即判上游挂死：断开本句、已收到的帧照播，tts.end 照常收尾，对话链继续。
   */
  private async speakSentence(sentence: string, turn: number): Promise<void> {
    if (this.turn !== turn || this.cancelled || this.skipRequested) return
    setDiagStage('tts-synth') // 【心跳埋点·长期保留】
    this.spoken.push(sentence)
    // 只留最近几句：回声延迟有限，太久以前的文本不该再参与比对
    if (this.spoken.length > 6) this.spoken.shift()
    // gapMs 必须 > TTS 单次合成超时（tts/http.ts 的 TTS_TIMEOUT_MS=20s），否则长文本合成
    // 还没返回，gap 就先判超时、误报「这段没能播报」。真机 100+ 字文本合成 7.35s，
    // 设 30s 给足余量（含偶发抖动重试）。
    const gapMs = this.deps.ttsFrameGapMs ?? 30_000
    let iterator: AsyncIterator<Uint8Array>
    try {
      iterator = this.tts.synthesize(sentence)[Symbol.asyncIterator]()
    } catch {
      // TTS 合成同步抛错：用本地 mp3 兜底（TTS 坏了不能再用 TTS 念兜底），
      // swallow 不抛出，链继续 → 外层正常发 tts.end → 队列推进下一条。
      bargeDiag(`TTS-FAIL synth threw, text="${sentence}"`)
      this.deps.send({ type: 'client.cue', cue: 'tts-error' })
      // 立即兑现播放等待：不让队列等 30s 超时才推进下一条（用户要求出错不卡队列）
      this.playbackPending = false
      this.resolvePlayback('tts-synth-threw')
      return
    }
    let gotAnyFrame = false
    try {
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | null = null
        const next = await Promise.race([
          iterator.next(),
          new Promise<'gap-timeout'>((resolve) => {
            timer = setTimeout(() => resolve('gap-timeout'), gapMs)
          }),
        ])
        if (timer) clearTimeout(timer)
        // 帧间超时：上游挂死，断开本句（已收到的帧照播，链继续）
        if (next === 'gap-timeout' || next.done) {
          // 一帧都没收到就超时＝TTS 真的没产出，给 mp3 提示；收到过部分帧的超时算正常截断
          if (next === 'gap-timeout' && !gotAnyFrame) {
            bargeDiag(`TTS-FAIL gap timeout no frame, text="${sentence}"`)
            this.deps.send({ type: 'client.cue', cue: 'tts-error' })
            this.playbackPending = false
            this.resolvePlayback('tts-gap-timeout')
          }
          break
        }
        const frame = next.value
        gotAnyFrame = true
        if (this.turn !== turn || this.cancelled || this.skipRequested) return
        setDiagStage('tts-send-audio') // 【心跳埋点·长期保留】帧下发段
        this.downlinkBytes += frame.byteLength
        this.echo.onDownlink()
        // 每下发一帧就把回声保护窗口往后挪：窗口始终盖住「最后一帧之后的一小段余音」
        this.echoUntil = Date.now() + 1200
        // 软件 AEC：把下发的 TTS（24k）推作远端参考；播报首帧 reset 一次，句间延续系数以覆盖回声尾。
        if (!this.aecActive) { this.aec.reset(); this.aecActive = true }
        this.aec.pushReference(frame)
        this.deps.sendAudio(frame)
      }
    } catch {
      // TTS 合成中途抛错：本地 mp3 兜底，swallow 让链继续（外层发 tts.end、队列推进）。
      // 不冒泡到 runAgent 的 catch——那会被误判成 LLM 失败。
      bargeDiag(`TTS-FAIL iter threw, text="${sentence}"`)
      this.deps.send({ type: 'client.cue', cue: 'tts-error' })
      // 立即兑现播放等待，队列不等超时
      this.playbackPending = false
      this.resolvePlayback('tts-iter-threw')
    } finally {
      void iterator.return?.()
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
    // 临时排查埋点：把探测结果落文件，真机上可经 run-as 读取，定位「发没发 cue」
    // 【异步】同步写改为异步，避免阻塞事件循环
    try {
      const home = process.env.GATEWAY_HOME ?? '.'
      appendFile(
        `${home}/gateway-debug.log`,
        `${new Date().toISOString()} probe down=${JSON.stringify(down)} report=${JSON.stringify(report)}\n`,
        () => {},
      )
    } catch {
      // 调试文件写失败不影响主流程
    }
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
    // 通用媒体控制（系统能力，非 skill）：按当前 lang 构造
    this.mediaControl = new MediaControl({
      media: this.media,
      lang: this.lang,
      send: (e) => this.deps.send(e),
      speak: (t) => this.speakReply(t),
      onStop: () => this.dispatchMediaStop(),
      defaultLoop: () => this.defaultLoop,
    })
    // 内容播放执行器（装配层注入实现）：依赖用 getter 读会话当前值，切源/重武装即时生效。
    // 只构造一次——它持有跨轮 pendingCandidates/nextFallback，重武装（复用会话）时重建会丢候选歌单。
    if (!this.content) {
      const executorDeps: ContentExecutorDeps = {
        lang: () => this.lang,
        speak: (t) => this.speakReply(t),
        send: (e) => this.deps.send(e),
        queueRemaining: () => this.queue.length,
        media: this.media,
        getSource: () => this.musicSource,
        candidateFetcher: this.deps.candidateFetcher,
        defaultLoop: () => this.defaultLoop,
        defaultVolume: () => this.defaultVolume,
        autoLoop: () => this.autoLoop,
        autoSubtitle: () => this.autoSubtitle,
        clearNewsContext: () => this.dispatchMediaStop(),
        hasPendingDeals: () => this.anySkillHasCandidates(),
        clearPendingDeals: () => this.dispatchClearOtherCandidates(),
        getLastTtsMedia: () => this.lastTtsMedia,
        playNewsVideo: (c) => this.dispatchExternalVideo(c),
        // 无明确内容时（如「放点音乐」「看。」），执行器据此从长期记忆偏好推荐候选，不自动播默认电台。
        getPreferenceKeywords: async () => {
          try {
            return preferenceKeywords((await this.memoryStore?.list()) ?? [])
          } catch {
            return []
          }
        },
      }
      this.content = this.deps.contentExecutorFactory(executorDeps)
    }
    // 用户没带时区或带的是非法值就退回东 8 区
    this.timezone = timezone?.trim() || 'Asia/Shanghai'
    this.mode = mode
    this.active = true
    this.lastVoice = voice
    // 构造 skill 实例与提示词片段（首次 start；重武装复用，状态由 cancel/end 清）。
    this.ensureSkills()
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
    this.cancelPlaybackWait('reset')
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
      // 本轮对话历史随旧 agent 作废可接受。重建前先关掉旧 MCP 客户端（stdio 子进程 / 网络连接）。
      await this.agent?.closeMcp?.()
      this.agent = mode === 'wake'
        ? null
        : await this.deps.agentFactory(
            resolved.llm,
            lang,
            this.timezone,
            () => this.getLocation(),
            this.memoryStore,
            this.memoryContext,
            () => this.requestClientLocation(),
            () => this.media.getNowPlaying(),
            this.autoMemory,
            this.mcpServers,
            this.deps.correctionSyncer?.engine,
            this.skillPromptAddon
          )
      this.lastLlmKey = llmKey
      return
    }

    // 全新会话：清空跨轮状态并重建 LLM（重武装/re-arm 走上面的早返回，不清商品候选）
    this.content.reset('start')
    this.dispatchSessionReset('start')
    this.recentUserTurns = []
    this.autoExtractRuns = 0
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
        : await this.deps.agentFactory(
            resolved.llm,
            lang,
            this.timezone,
            () => this.getLocation(),
            memoryStore,
            memoryContext,
            () => this.requestClientLocation(),
            () => this.media.getNowPlaying(),
            this.autoMemory,
            this.mcpServers,
            this.deps.correctionSyncer?.engine,
            this.skillPromptAddon
          )
    this.lastLlmKey = llmKey
    this.sessionRowId = await this.deps.data.createSession(this.deviceId, Date.now())
  }

  private cancel(): void {
    // 手动打断：作废当前轮、清空排队，在途回调靠 turn 号退出
    this.dispatchSessionReset('cancel')
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
    this.cancelPlaybackWait('session-cancel')
    if (wasSpeaking) this.deps.send({ type: 'tts.stop' })
    // 手动打断证明是真人，解除回声兜底
    this.echo.release()
    this.syncDuplex()
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.asr.reset()
    this.vad.reset()
  }

  /**
   * 播报/思考中重新喊「小熊小熊」：只跳过当前这一句，队列照常继续。
   *
   * 与 cancel() 的本质区别：不 ++turn、不置 cancelled、不清 queue。turn/cancelled 是
   * 「整条链作废」的语义——一旦动它，runTurn 的 while 会在下一处 break，排队的句子
   * 就再没人消费。这里改用一个只作用于「当前项」的 skipRequested 标志：
   * 在途的 speakSentence / runAgent 看到它立即停止下发，但 runTurn 的链继续，
   * 解除播放等待后自然 shift 出队首下一句接着播。客户端的「我在」招呼由客户端本地播。
   * dropText：这句唤醒词刚被 enqueueDuringBusy 放进队列（经 asr.queued 透传给客户端匹配），
   * 不是用户指令——从队尾移除，避免 runTurn 把它当一句话交给 LLM。
   */
  private skipCurrent(dropText?: string): void {
    if (!this.active || this.cancelled) return
    // 没有正在跑的轮次就没什么可跳的，避免误伤空闲态
    if (!this.processing && !this.playbackPending) return
    // 唤醒词本身不该进队列：从尾部找，确保删的是「刚识别的这一句」而非更早的重复文本。
    if (dropText) {
      const i = this.queue.lastIndexOf(dropText)
      if (i >= 0) this.queue.splice(i, 1)
    }
    // 音频已下发完（tts.end）时 speaking 已为 false，但客户端可能仍在播、等 playback_done；
    // 只要处于播放窗口就必须发 tts.stop，否则客户端 isSpeaking 不复位，下一句 tts.start
    // 会被它的抗重复挡掉，队列就卡住不播了。
    const wasPlaying = this.playbackPending || this.speaking
    this.skipRequested = true
    this.speaking = false
    this.playbackPending = false
    this.echoUntil = 0
    // 解除「等播完」阻塞：runTurn 的 await playback 立即返回，随后检查 turn/cancelled
    // 均未变（不在 break 条件里加 skipRequested），于是继续 shift 队列下一句。
    this.cancelPlaybackWait('skip-current')
    if (wasPlaying) this.deps.send({ type: 'tts.stop' })
    // 真人打断，解除回声兜底，恢复全双工拾音，让下一句能被正常识别
    this.echo.release()
    this.syncDuplex()
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    this.asr.reset()
    this.vad.reset()
  }

  private end(): void {
    this.dispatchSessionReset('end')
    this.active = false
    this.cancelled = true
    this.turn += 1
    this.speaking = false
    this.playbackPending = false
    this.echoUntil = 0
    this.queue.length = 0
    this.content.reset('end')
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait('session-end')
    if (this.endpointTimer) clearTimeout(this.endpointTimer)
    if (this.sessionRowId) this.deps.data.endSession(this.sessionRowId, Date.now())
    this.asr.reset()
    this.vad.reset()
    // 会话显式结束：关掉 MCP 客户端（stdio 子进程 / 网络连接）后销毁对话记忆，
    // 下次 start 视为全新会话（不再保留历史/候选）。
    void this.agent?.closeMcp?.()
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
    this.cancelPlaybackWait('close')
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
  // 句末标点：立即切句送 TTS
  const match = text.match(/[。！？；!?;\n]/)
  if (match && match.index !== undefined) return match.index + 1
  // 逗号/顿号：LLM 回复开头常有一长串没句号的文字，等句末标点才启动 TTS 会让
  // "文字刷出来了、声音迟迟不来"。遇到逗号就切，让用户更早听到声音。
  const comma = text.match(/[，、,]/)
  if (comma && comma.index !== undefined && comma.index >= 4) return comma.index + 1
  // 无标点时长文本兜底：降到 20 字（原 60 字），避免 LLM 一路不写标点时干等。
  if (text.length >= 20) return 20
  return -1
}
