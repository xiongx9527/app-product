import type { AsrProvider } from '../asr'
import type { TtsProvider } from '../tts'
import { Solar } from 'lunar-javascript'
import type { AgentService } from './agentService'
import type { DataService } from './dataService'
import type { ClientMessage, Lang, LocationInfo, McpServerConfig, ServerEvent, ServerErrorCode, SubtitleLine } from '../protocol'
import type { GatewayConfig } from '../config'
import type { AsrConfig, LlmConfig, TtsConfig } from '../config'
import type { VoiceConfig, ResolvedCapabilities } from '../voiceConfig'
import { createMusicSource, needsProxy, type MusicSource } from './music'
import { MusicSourceNotImplementedError } from './music/types'
import { genreToKeyword, isGenericPlayPhrase, isSpokenContentRequest, detectContentType } from './music/types'
import { formatMemories, formatDeals, type MemoryStore, type RequestLocation } from './tools'
import { createDealsTool, enrichDeal, type DealsSnapshot } from './tools/dealsTool'
import { createDealsSource, createDealsAllSources, toDetailItems, type Deal, type DealDetail } from './deals'
import { detectDealsCommand } from './control/dealsControl'
import {
  searchCandidates,
  needsCandidateList,
  candidateQuery,
  parseSelection,
  looksLikeSelectionAttempt,
  looksLikeBareMusicQuery,
  contentWords,
  filterByCurrentArtist,
  isArtistBrowse,
  type MusicCandidate,
  type CandidateFetcher,
} from './music/musicCandidates'
import { detectMusicCommand, parseLoopCount, hasAgainMarker } from './control/musicControl'
import { detectVolumeCommand } from './control/volumeControl'
import { detectMemoryCommand } from './control/memoryControl'
import { pickDeals, preferenceKeywords } from './memory'
import { detectSubtitleCommand } from './control/subtitleControl'
import { detectPlayModeCommand } from './control/playModeControl'
import { isTimeQuery } from './skills/time_skill'
import { detectAuspiciousQuery, type AuspiciousQuery } from './control/auspiciousControl'
import { ensureAdtsFile, adtsKeyFor, recordMusicDiag } from '../controller/musicStreamController'
import { detectWeatherCommand, extractWeatherCity } from './control/weatherControl'
import { detectProductQuery } from './control/productCatalog'
import { detectNewsCommand, detectNewsNextCommand } from './control/newsControl'
import { detectBaikeCommand } from './control/baikeControl'
import { detectPoemCommand } from './control/poemControl'
import { createNewsVideoSource, cleanNewsTitle, type NewsVideoCandidate, type NewsVideoSourceLike } from './news'
import { createWeatherTool } from './tools/weatherTool'
import { createBaikeTool } from './tools/baikeTool'
import type { BaikeEntry } from './baike'
import { queryPoem, type PoemEntry } from './edu'
import { fetchBaikeAudioUrl, splitSummaryToLines } from './baike/baidu/baikeTts'
import { cacheExternalAudio, getCachedAudioDuration, type MediaFetcher } from './mediaCache'
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
import { appendFileSync } from 'node:fs'

// ===== 临时诊断：播报期插话识别链路（定位后移除）=====
let bargeDiagAt = 0
/** 累计收到的音频帧数（每 50 帧落一条），与 pb 状态/节流无关，确认网关是否真的在收帧 */
let bargeFrames = 0
let bargeLoudFrames = 0
function bargeDiag(line: string): void {
  try {
    const home = process.env.GATEWAY_HOME ?? '.'
    appendFileSync(`${home}/barge-diag.log`, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // 诊断写失败不影响主流程
  }
}

/** 播报期间最多排几句用户插话，超出直接拒收。 */
const MAX_QUEUE = 3

/**
 * 单轮 LLM 的硬超时（毫秒）：上游慢/挂起时主动舍弃本轮、断开下行播放，
 * 立即播友好兜底，不让用户干等。测试可经 deps.llmTimeoutMs 注入更短的值。
 */
const DEFAULT_LLM_TIMEOUT_MS = 15000

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
    getMusicSource?: () => MusicSource | undefined,
    emit?: (m: ServerEvent) => void,
    memoryStore?: MemoryStore,
    memoryContext?: string,
    requestLocation?: RequestLocation,
    autoSubtitle?: boolean,
    defaultLoop?: number,
    defaultVolume?: number,
    autoLoop?: boolean,
    dealsCount?: number,
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
  /** 构造音乐播放源；测试可注入桩避免联网，缺省用网关内置的无配置源 */
  musicSourceFactory?: () => MusicSource
  /** 检索候选歌曲（MusicBrainz）；测试可注入桩避免联网 */
  candidateFetcher?: CandidateFetcher
  /** 查询商品/好价：测试可注入桩避免联网。一次返回口播文本 + 结构化 Deal[]，
   *  缺省用 createDealsTool.snapshot（工具与直连共用同一抓取缓存，零二次抓取）。 */
  dealsQuery?: (keyword?: string | null) => Promise<DealsSnapshot>
  /** 天气查询：测试可注入桩避免联网。缺省用 createWeatherTool.call（懒加载位置 + 自带超时）。 */
  weatherQuery?: () => Promise<string>
  /** 新闻视频音源：抓真实新闻视频并抽音轨。缺省用 B 站源；测试可注入桩避免联网。 */
  newsVideoSource?: NewsVideoSourceLike
  /** 百科查询：测试可注入桩避免联网。缺省用 createBaikeTool.snapshotWithText（多源可换）。 */
  baikeQuery?: (query: string) => Promise<{ entry: BaikeEntry | null; text: string; spoken?: string }>
  /** 诗词/古文查询：测试可注入桩避免联网。缺省用 queryPoem（edu/baidu）。 */
  poemQuery?: (title: string) => Promise<PoemEntry | null>
  /** ASR 同音错字纠正（定稿时当场纠，让「我说」框显示正确文字）。测试可注入桩；缺省用内置 AsrCorrector。 */
  asrCorrect?: (text: string) => string
  /** 百科播报音频直链：调百度百科 getaudio 拿 mp3 URL。测试可注入桩避免联网。 */
  baikeAudioUrl?: (text: string) => Promise<string>
  /** 外部音频本地短链缓存：下载 mp3 落盘返回 /media/s/<key>.mp3。测试默认 no-op（返回 null→回退原 url）。 */
  mediaCache?: (url: string, fetcher?: MediaFetcher) => Promise<string | null>
  /** 单轮 LLM 超时（毫秒）：超时主动舍弃本轮、断开下行播放、立即播友好兜底。测试注入更小值。 */
  llmTimeoutMs?: number
  /** TTS 帧间看门狗（毫秒）：上游挂起不产帧时断开本句，对话链绝不卡死。测试注入更小值。 */
  ttsFrameGapMs?: number
  /** 选中某件后补抓它的详情页（优惠说明/品牌/权威时间/大图）；测试可注入桩避免联网。
   *  缺省走数据源自身的 detailUrl + parseDetail，拿不到就返回 null（卡片用列表数据照常展示）。 */
  dealsDetail?: (deal: Deal) => Promise<DealDetail | null>
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
  private musicSource: MusicSource | undefined = undefined
  /**
   * 最近一次下发的曲目，供「循环播放」复用同一首重播。
   * contentType 记住当前播的是歌 / 评书 / 戏曲 / 电影…（歌曲为 undefined），
   * 后续换内容、失败提示都据此措辞，避免一律当成「放歌」。
   */
  private lastTrack: { url: string; title: string; channel?: string; cover?: string; artist?: string; contentType?: string } | null = null
  /**
   * 最后一次播放的百科/诗词媒体（tts）：「重新播放」要重现它而不是找歌。
   * 记下重播所需的全部字段——音频 url/本地短链、封面、字幕行、标题；音乐重播仍走 lastTrack。
   */
  private lastTtsMedia: {
    url: string; title: string; audioPath?: string; cover?: string;
    lines: Array<{ time: number; text: string }>
  } | null = null
  /** 自动字幕开关：播放音乐时同源字幕是否自动拉取并展示；来自客户端设置（缺省开启）。 */
  private autoSubtitle = true
  /** 上一次成功下发的同源字幕，供「循环播放」重播同一首时复用，避免重新拉取失败把字幕覆盖成「暂无字幕」 */
  private lastSubtitleLines: SubtitleLine[] | null = null
  /** 当前是否真的有字幕面板在显示：仅在成功下发非空字幕时为 true，用于「关闭字幕」时如实反馈 */
  private subtitleActive = false
  /** 最近一次 session.start 带下来的语音来源配置：供 announceCapabilityProblems 按「实际会用的那套能力」
   *  探测就绪状态（而非永远探测网关默认的内置），与 /api/health 的 provider-aware 探测保持一致。 */
  private lastVoice: VoiceConfig | undefined = undefined
  /** 新闻播报的视频音源：抓真实新闻视频、抽音轨，走与音乐相同的 dash 短链下发。 */
  private newsVideoSource: NewsVideoSourceLike
  /**
   * 当前新闻播放上下文：本轮抓到的新闻候选 + 正在播的下标（未选时为 -1）+ 话题词。
   * 有了它，「播放下一条 / 换一条」在新闻场景下接着切新闻，不会被音乐分支的「播放」当成点歌。
   * 一旦开始播音乐 / 停止 / 会话结束就清空，避免跨场景串台。
   */
  private newsPlayback: { items: NewsVideoCandidate[]; index: number; keyword: string | null } | null = null
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
  /** 好价商品推荐条数：来自客户端设置页 session.start.recommend.dealsCount，缺省 3，范围 1–10。 */
  private dealsCount = 3
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
  /** 当前是否正在播放（播放/切歌/循环置真，停止置假）。决定「点歌按当前歌手优先」是否生效：
   *  仅当用户正处于某个歌手的播放会话时才自动选同歌手版本；已停止则老老实实列选项让用户选。 */
  private musicActive = false
  /** 百科/诗词(tts)媒体是否在播：这类 media.play 不置 musicActive（不影响同歌手选歌/nowPlaying），
   *  但说「暂停/继续/停掉」时它同样是有效媒体，不能谎答「没在播放」。下发 tts media.play 置真，
   *  pause/stop 后清假；播完客户端无上行回执（与音乐一致），靠下次操作覆盖，不误用。 */
  private ttsMediaActive = false
  /** 音乐播放音量（0–1）：网关认定的权威值，随客户端滑块回执同步；语音「调大/调小」相对增减用。 */
  private musicVolume = 0.5
  /** 待用户用语音选择的候选歌曲列表：口播编号后挂起，下一句解析「第几首 / 歌名」 */
  private pendingCandidates: { items: MusicCandidate[]; query: string } | null = null
  /**
   * 待用户说编号选中的商品列表：口播编号后挂起，下一句解析「1 / 第二个 / 商品名」。
   * 与音乐候选分开、生命周期独立：cancel()/重武装(re-arm)不清，仅 end()/全新 start 清空——
   * 切语音来源（设置页 rearm 重发 session.start）不应让编号失效（「换源不出问题」）。
   * 商品数据只经 media.detail 下发，绝不进 session.start.voice.params 共用通道。
   */
  private pendingDeals: { items: Deal[]; query: string } | null = null
  /**
   * 本次会话的 skill 实例（由 deps.skillModules 各 create 一个）。偏好追问等业务规则
   * 已迁进 skill，状态在实例闭包里；网关只在对应时机按序调用生命周期钩子。
   */
  private skills: Skill[] = []
  /** 所有启用 skill 的提示词片段拼接结果（构造 agent 时一次算好，传给 agentFactory）。 */
  private skillPromptAddon = ''
  /** 上一轮「换一首」没找到同类型的歌，正等用户确认是否换其它风格（不直接乱播） */
  private pendingNextFallback = false
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
  /** 等待客户端「播完」回执的 resolve；processing 会一直保持到它触发。 */
  private playbackResolve: (() => void) | null = null
  private playbackTimer: ReturnType<typeof setTimeout> | null = null
  /** 定稿串行链：多个 endpoint 定时器重叠时逐句处理，不丢句也不抢同一段缓冲。 */
  private finalizeChain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: VoiceSessionDeps) {
    this.deviceId = deps.deviceId ?? null
    this.newsVideoSource = deps.newsVideoSource ?? createNewsVideoSource()
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
        // 推荐条数：来自客户端设置页（session.start.recommend），缺省各 3，收敛到 1–10 整数。
        const rc = msg.recommend
        const toCount = (v: unknown, fallback: number): number => {
          const n = Number(v)
          return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.floor(n))) : fallback
        }
        this.dealsCount = toCount(rc?.dealsCount, 3)
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
      case 'session.skip_current':
        bargeDiag(`SKIP-CURRENT recv drop=${msg.dropText ?? ''} pb=${this.playbackPending} proc=${this.processing} queue=${this.queue.length}`)
        this.skipCurrent(msg.dropText)
        break
      case 'session.end':
        this.end()
        break
      case 'session.playback_done':
        this.resolvePlayback()
        // 原生直连播空回执：下发 tts.idle 让客户端据此收尾（替代播报期不可靠的 weex idle 回调，
        // 铁证：客户端只能靠 12s 兜底）。onPlaybackSettled 幂等，重复触发无害。
        this.deps.send({ type: 'tts.idle' })
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
    // 客户端点「换一首」即进入音乐场景，清掉新闻切条上下文
    this.newsPlayback = null
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
    // dash 音轨：后台预热，不阻塞 media.play（转封装要拉满整轨 9MB+，等它会让播放器
    // 迟迟不出现）；客户端请求短链时网关会等同一 key 的 in-flight 转封装。
    const dashNext = needsProxy(track.channel, track.url) && track.url.includes('.m4s')
    if (dashNext) void this.prewarmDashAudio(track)
    // 默认循环次数带入：仅当「自动循环播放」开启时换歌也默认循环，>1 才下发 loop。
    this.deps.send({
      type: 'media.play',
      url: track.url,
      title: track.title,
      channel: track.channel,
      // dash 走短链本地播放，不再给长代理 URL（长 URL 会被 DCloud 下载器截断）
      proxy: dashNext ? false : needsProxy(track.channel, track.url),
      ...(dashNext ? { audioPath: `music/s/${adtsKeyFor(track.url)}.aac` } : {}),
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
    // 真正开始播音乐了：新闻切条上下文到此为止，之后「下一条」应走音乐换歌。
    this.newsPlayback = null
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
    // dash 纯音轨预热与口播并行，且**不阻塞 media.play**：整轨 9MB+ 的拉取要好几秒，
    // 等它会让播放器迟迟不出现（用户感知「播放器打开慢」）。先下发 media.play 让播放器
    // 立刻出现，客户端请求短链时网关等同一 key 的 in-flight 转封装。
    // 注意口播不能 await：空闲直连路径下 speakReply 会自建「等播完回执」的等待，
    // await 它会阻塞到 playback_done（播放器永远出不来）；链内路径则由 runTurn 统一等。
    void this.prewarmDashAudio(track)
    const speak = this.speakReply(confirm)
    // 自动字幕：开关开启时，播放这首歌后尽力同源拉取字幕并下发（无字幕则不显示，不弹面板）。
    void this.emitAutoSubtitle(track.title, artist, reuseSubtitle)
    const dashTrack = needsProxy(track.channel, track.url) && track.url.includes('.m4s')
    this.deps.send({
      type: 'media.play',
      url: track.url,
      title: track.title,
      channel: track.channel,
      // dash 走短链本地播放（长代理 URL 会被 DCloud 下载器截断，实测 936 字节即断）
      proxy: dashTrack ? false : needsProxy(track.channel, track.url),
      ...(dashTrack ? { audioPath: `music/s/${adtsKeyFor(track.url)}.aac` } : {}),
      ...(effectiveLoop && effectiveLoop > 1 ? { loop: effectiveLoop } : {}),
      ...(track.cover ? { cover: track.cover } : {}),
    })
    void speak
  }

  /**
   * dash 纯音轨（.m4s）预热：转封装进 /music/stream 的缓存，让客户端首次请求秒回。
   * B站直链每次解析都变（签名/deadline），不预热则每次首播都要现场拉 11MB+转封装，
   * DCloud AudioPlayer prepare 超时就无声。失败静默：预热失败时客户端请求会现场转（慢但能用）。
   */
  private prewarmDashAudio(track: { url: string; channel?: string }): Promise<void> {
    if (!needsProxy(track.channel, track.url) || !track.url.includes('.m4s')) return Promise.resolve()
    return ensureAdtsFile(track.url).then(() => undefined).catch(() => undefined)
  }

  /**
   * 自动字幕：开关开启时，用当前音乐源拉取字幕并下发 media.subtitle。
   * 尽力而为——拉取失败/超时不影响播放；取不到时也下发空 lyrics，让客户端显示「暂无字幕」而非什么都不提示。
   */
  private async emitAutoSubtitle(title: string, artist?: string, reuse = false): Promise<boolean> {
    if (!this.autoSubtitle) {
      recordMusicDiag(`subtitle skip: autoSubtitle=off title=${title.slice(0, 16)}`)
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
      recordMusicDiag('subtitle skip: source has no getSubtitle')
      this.subtitleActive = false
      return false
    }
    try {
      const lines = await source.getSubtitle(artist ?? '', title)
      recordMusicDiag(`subtitle emit lines=${(lines ?? []).length} title=${title.slice(0, 16)}`)
      this.lastSubtitleLines = lines ?? []
      this.deps.send({ type: 'media.subtitle', title, artist, lines: lines ?? [] })
      this.subtitleActive = (lines ?? []).length > 0
      return this.subtitleActive
    } catch {
      recordMusicDiag('subtitle fail: getSubtitle threw')
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
    // 点歌候选与商品候选互斥：同时挂着会让「第二个」到底选歌还是选商品产生歧义。
    this.pendingDeals = null
    const labels = items.map((c) => (c.artist ? `${c.title}，${c.artist}` : c.title))
    await this.speakReply(
      (recommend ? m.recommend(labels) : m.candidates(labels)) + m.chooseHint()
    )
    return true
  }

  /** 用「用户核心词 + 选中歌名」拼成歌手+歌名去抽音轨，接上严格匹配，避免乱播。 */
  private async playChosen(chosen: MusicCandidate, query: string): Promise<void> {
    // 新闻视频候选：和音乐共用选号流程，但选中后抽该视频音轨播放，不走点歌源。
    if (chosen.newsBvid) {
      await this.playNewsVideo({ bvid: chosen.newsBvid, title: chosen.title, cover: chosen.newsCover })
      return
    }
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
      // 与商品/开源选号同一套：候选歌单还在，不能因为一句没说清的话就清掉，
      // 用户回头再说「第二首」必须还能选中。
      // 像在报编号却没对上（含糊/听错/越界）时就地重问并消费这句，
      // 不放行到 LLM / 音乐直连，避免被答成「推荐歌曲」或再列一次歌单。
      if (looksLikeSelectionAttempt(text)) {
        this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
        // 新闻候选与音乐候选共用选号，重问话术按候选类型区分（新闻说「第几条」）。
        const isNews = pending.items.some((c) => c.newsBvid)
        await this.speakReply(
          isNews ? messages(this.lang).news.chooseAgain() : messages(this.lang).music.chooseAgain()
        )
        return true
      }
      return false
    }
    this.pendingCandidates = null
    this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
    await this.playChosen(pending.items[idx], pending.query)
    return true
  }

  private async runMusicCommand(action: NonNullable<ReturnType<typeof detectMusicCommand>>, text: string): Promise<void> {
    // 只有「找新歌」类动作需要音乐源；pause/resume/stop/replay 操作的是已下发/已记住的媒体
    // （音乐或百科/诗词），与音乐源无关——没配音乐源时这些也必须能执行，否则会交 LLM 乱答。
    const needsSource = action === 'play' || action === 'next' || action === 'recommend' || action === 'loop'
    const source = this.musicSource
    if (needsSource && !source) return
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
          const track = await source!.resolve(genre)
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
          // 百科/诗词(tts)媒体在播也算——它不置 musicActive，得单独认 ttsMediaActive。
          if (!this.musicActive && !this.ttsMediaActive) {
            await this.speakReply(m.musicNotPlaying())
            break
          }
          this.deps.send({ type: 'media.pause' })
          // 暂停≠停止：媒体仍在（只是 paused），保留 ttsMediaActive，否则「继续/停止」会误判没在播。
          // 与 music 一致——music 的 pause 从不清 musicActive，只有 stop 才清。
          await this.speakReply(m.paused())
          break
        case 'resume':
          if (!this.musicActive && !this.ttsMediaActive) {
            await this.speakReply(m.musicNotPlaying())
            break
          }
          this.deps.send({ type: 'media.resume' })
          await this.speakReply(m.resumed())
          break
        case 'stop': {
          // 新闻播报不置 musicActive，但它同样是媒体播放：「停掉」要真停并清掉切条上下文。
          const wasNews = this.newsPlayback !== null
          this.newsPlayback = null
          if (!this.musicActive && !this.ttsMediaActive && !wasNews) {
            await this.speakReply(m.musicNotPlaying())
            break
          }
          this.deps.send({ type: 'media.stop' })
          this.musicActive = false
          this.ttsMediaActive = false
          this.subtitleActive = false
          await this.speakReply(m.stopped())
          break
        }
        case 'replay': {
          // 重新播放 = 把最后一次播放的内容从头再放一次（歌 / 百科 / 诗词），不是找歌。
          // 优先 tts（最近一次百科/诗词），其次音乐曲目；都没播过就如实说没有可重播的。
          if (this.lastTtsMedia) {
            const last = this.lastTtsMedia
            this.deps.send({ type: 'media.subtitle', title: last.title, lines: last.lines })
            this.deps.send({
              type: 'media.play',
              url: last.url,
              title: last.title,
              source: 'tts',
              ...(last.audioPath ? { audioPath: last.audioPath } : {}),
              ...(last.cover ? { cover: last.cover } : {}),
            })
            this.ttsMediaActive = true
            await this.speakReply(messages(this.lang).baike.playing(last.title))
            break
          }
          if (this.lastTrack) {
            await this.playTrack(this.lastTrack, m.playing(this.lastTrack.title), undefined, this.lastTrack.artist, true)
            this.musicActive = true
            break
          }
          await this.speakReply(m.musicNotPlaying())
          break
        }
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
    // 择吉日/黄历：库内置权威宜忌数据、答案确定，绕开大模型直连；必须排在时间直连之前，
    // 防止未来时间正则扩展出「日子」类词后抢走「推荐个吉日」。
    const auspicious = detectAuspiciousQuery(text)
    if (auspicious) {
      await this.runAuspiciousCommand(auspicious)
      return true
    }
    // 时间/日期：业务已迁进 time_skill（priority=20），按 skill 优先级调度。
    // 目前只有 time_skill 挂 onDirectCommand，等价原来的 detectTimeCommandKind 分支；
    // 后续 control 逐个迁进来后，这里会成为统一的 skill 调度点。
    if (await this.dispatchDirectCommand(text)) return true
    if (detectWeatherCommand(text)) {
      await this.runWeatherCommand(extractWeatherCity(text) ?? undefined)
      return true
    }
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
    // 新闻播放中的「下一条 / 换一条」必须先于新闻重搜与音乐指令拦截：
    // 这句本身没有新闻词，detectNewsCommand 命中不了；musicControl 的「播放」会把它当点歌
    // 去搜「下一条」这首歌。只有确实在播新闻时才拦，音乐场景照旧走 music.next。
    if (this.newsPlayback && detectNewsNextCommand(text)) {
      await this.playNextNews()
      return true
    }
    // 新闻播报含「播放新闻 / 播放资讯」，musicControl 的 play 正则含裸「播放/放」会当点歌，
    // 故新闻检测必须排在音乐指令之前（同类于上面的 playMode）。
    const news = detectNewsCommand(text)
    if (news) {
      await this.runNewsCommand(news.keyword)
      return true
    }
    // 百科查询：「百科XX / XX的事迹 / 介绍下XX / XX人物生平」等，抓真实词条摘要显示+播报。
    // 放在好价（detectProductQuery）之前——「查百科」含「查」会被好价误中。
    const baike = detectBaikeCommand(text)
    if (baike) {
      await this.runBaikeCommand(baike.keyword)
      return true
    }
    // 诗词/古文朗读：背诵/朗诵/念/读 + 作品名，走 edu 数据源（原文+百度朗读音频），
    // 不让 LLM 自己背全文。放在百科之后、音乐之前。
    const poem = detectPoemCommand(text)
    if (poem && await this.runPoemCommand(poem.title)) {
      return true
    }
    // 诗词意图但没查到：runPoemCommand 返回 false，继续往下走交 LLM（受 ≤100 字闸门兜底）
    const action = detectMusicCommand(text)
    const effectiveAction: NonNullable<ReturnType<typeof detectMusicCommand>> | null =
      action ?? (this.musicSource && looksLikeBareMusicQuery(text) ? 'play' : null)
    // pause/resume/stop/replay 操作当前/上次媒体（含百科/诗词 tts），不依赖 musicSource；
    // 只有找歌类（play/next/recommend/loop）才要求已配置音乐源，否则会漏给 LLM 乱答「没这首歌」。
    const mediaOnlyAction = effectiveAction === 'pause' || effectiveAction === 'resume' || effectiveAction === 'stop' || effectiveAction === 'replay'
    if (effectiveAction && (mediaOnlyAction || this.musicSource)) {
      await this.runMusicCommand(effectiveAction, text)
      return true
    }
    // 商品/好价查询放最后：不抢记忆/音量/字幕/播放模式/音乐等既有直连命令。
    // 实物商品名/交易词（推荐一款空调、买卖…）→ 带关键词走站内真搜索；
    // 好价信号句（有什么折扣、便宜的东西…）→ 限定好价 feed；都绕开 LLM 直接查。
    const product = detectProductQuery(text)
    if (product) {
      await this.runDealsCommand(product.keyword)
      return true
    }
    if (detectDealsCommand(text)) {
      await this.runDealsCommand()
      return true
    }
    return false
  }

  /**
   * 时间/日期直连：本地时钟按会话时区取值，直接口播，零网络、零 LLM。
   * 按识别出的意图分流——问时间只报时分；问日期（星期几 / 几月几号）必须报全
   * 「X年X月X日 星期X」；两样都问就都报。日期文案按 lang 本地化（weekday 由 Intl 产出）。
   */
  /**
   * 择吉日直连：用 lunar-javascript 内置的权威黄历宜忌数据扫未来日期，直接口播，
   * 零网络、零 LLM。带事项（「搬家吉日」）找宜该事项的日子；没说事项推荐宜较多的日子。
   * 日期/星期/农历串固定中文（与日期直连同口径，不随语言英化）；扫 30 天，报前 3 个。
   */
  private async runAuspiciousCommand(q: AuspiciousQuery): Promise<void> {
    const m = messages(this.lang)
    // 起点日按会话时区取（与时间直连同一套 en-GB parts 手法，不依赖进程本地时区）
    const todayParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    }).formatToParts(new Date())
    const pick = (type: string) => todayParts.find((p) => p.type === type)?.value ?? ''
    const WEEKDAY_ZH: Record<string, string> = {
      Sun: '星期日', Mon: '星期一', Tue: '星期二', Wed: '星期三',
      Thu: '星期四', Fri: '星期五', Sat: '星期六',
    }
    const startY = Number(pick('year'))
    const startMo = Number(pick('month'))
    const startD = Number(pick('day'))
    // 用 UTC 时间轴逐日 +1（无时区漂移），每格按序号构造 Solar.fromYmd
    const baseMs = Date.UTC(startY, startMo - 1, startD)
    const SCAN_DAYS = 30
    const REPORT_LIMIT = 3
    const matched: string[] = []
    for (let i = 0; i < SCAN_DAYS && matched.length < REPORT_LIMIT; i += 1) {
      const dt = new Date(baseMs + i * 86400000)
      const y = dt.getUTCFullYear()
      const mo = dt.getUTCMonth() + 1
      const d = dt.getUTCDate()
      const weekday = WEEKDAY_ZH[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()]] ?? ''
      const lunar = Solar.fromYmd(y, mo, d).getLunar()
      const yi = lunar.getDayYi()
      const leap = lunar.getMonth() < 0 ? '闰' : ''
      // 带事项：只报日期；泛吉日：顺带报当天前 3 个宜词，让用户知道那天适合什么
      const dayLabel =
        `${mo}月${d}日（${weekday}，农历${leap}${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`
        + (q.yiWords.length ? '' : `，宜${yi.slice(0, 3).join('、')}`) + '）'
      const isMatch =
        q.yiWords.length > 0
          ? q.yiWords.some((w) => yi.includes(w))
          : yi.length >= 4
      if (isMatch) matched.push(dayLabel)
    }
    if (!matched.length) {
      await this.speakReply(m.auspicious.none(q.activity ?? '这件事'))
      return
    }
    const daysText = matched.join('、')
    await this.speakReply(
      q.activity ? m.auspicious.found(q.activity, daysText) : m.auspicious.best(daysText),
    )
  }


  /** 天气直连：复用天气数据源（懒加载位置），不进 LLM。超时/失败给友好兜底。 */
  private async runWeatherCommand(city?: string): Promise<void> {
    const query =
      this.deps.weatherQuery ??
      (async (): Promise<string> => {
        const tool = createWeatherTool(
          this.lang,
          () => this.getLocation(),
          undefined,
          () => this.requestClientLocation(),
        )
        // 指定城市走 source.fetchCity（抽象接口，可换源）；无城市名则查设备定位
        return tool.call(city ? { city } : undefined)
      })
    try {
      await this.speakReply(await query())
    } catch {
      await this.speakReply(messages(this.lang).llmUnavailable())
    }
  }

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
   * 百科查询直连（绕开 LLM）：抓真实百科词条摘要 → 助手框显示 + TTS 播报。
   * keyword 为空（纯「百科」）时提示用户说查谁；有词时用注入的 query 或默认工具。
   * 与新闻一样走 media.play 播真实音频（百度百科自己的 TTS 直链），文字不进助手框；
   * 只有查询失败/音频接口失败降级为网关文字口播时才显示文字。
   */
  private async runBaikeCommand(keyword: string | null): Promise<void> {
    if (!keyword) {
      await this.speakReply(messages(this.lang).baike.prompt())
      return
    }
    const query =
      this.deps.baikeQuery ??
      (async () => createBaikeTool(this.lang).snapshotWithText(keyword))
    let text: string
    let title: string
    /** 真正会被播报的正文（与音频同源）；字幕必须用它，不能用完整 summary。 */
    let spoken: string
    let image: string | undefined
    try {
      const r = await query(keyword)
      if (!r.entry) {
        // 没查到词条：只有兜底文案、没有可播报的百科内容，照常文字口播
        await this.speakReply(r.text)
        return
      }
      text = r.text
      title = r.entry.title || keyword
      // 数据源已替我们做了同音纠错（如"李存旭"→返回"李存勖"词条）。
      // 若输入词与返回标题同音但字面不同，说明这是一个 ASR 同音错词对——自动学进本地
      // 词表，下次识别该错词就能直接纠正，不必再依赖数据源侧的联想。零网络、立即生效。
      void this.autoLearnCorrection(keyword, title)
      // 桩/旧实现可能不带 spoken：退回完整摘要（行为同旧版，不炸）
      spoken = r.spoken ?? r.entry.summary ?? ''
      image = r.entry.image
    } catch {
      await this.speakReply(messages(this.lang).llmUnavailable())
      return
    }
    // 百科音频必须用百度百科自己的语音（用户明确要求不要网关文字转语音）：
    // 调 getaudio 拿 mp3 直链，media.play 下发让客户端边下边播。URL 只用一次、随即下发，
    // 不做长期缓存（百度音频直链约一百多分钟有效）。
    try {
      const audioUrl = this.deps.baikeAudioUrl
        ? await this.deps.baikeAudioUrl(text)
        : await fetchBaikeAudioUrl(text)
      // 第三方 mp3 直链 DCloud AudioPlayer 直拉不稳（-99、不发请求）——先落盘成本地短链再下发。
      // 缓存失败就回退原始 url（至少有可能播），audioPath 有值时客户端走下载本地播的稳定链路。
      const mediaPath = await (this.deps.mediaCache ?? cacheExternalAudio)(audioUrl)
      // 用落盘音频的真实时长生成字幕 time：网关按字数估算的语速（4.5字/秒）远慢于百度 TTS 实际
      // （实测 6.5字/秒），不按真实时长铺会让字幕走不完/走太快。拿不到时长就回退估算。
      const durationSec = mediaPath ? getCachedAudioDuration(mediaPath) : 0
      // 确认句走 speakReply：既在助手框显示、也 TTS 播报出来（同音乐/新闻点歌确认）。
      // 不 await，避免阻塞 media.play；百科全文不进助手框、只在字幕面板逐句展示。
      void this.speakReply(messages(this.lang).baike.playing(title))
      // 字幕转成歌词格式：只切「真正被播报的正文」并按真实音频时长铺满。
      // 不能用完整 summary——音频只念 trimSummary(≤300 字)，用 500 字摘要铺 66 秒会让字幕
      // 每秒推进 7.6 字而语音只有 4.3 字/秒（真机实测第 2 行提前 11 秒翻、末尾还显示没播的内容）。
      const subtitleLines = splitSummaryToLines(spoken, durationSec || undefined)
      this.deps.send({ type: 'media.subtitle', title, lines: subtitleLines })
      // 封面用百科卡片的词条配图（同源），无图则不覆盖（客户端会按 cover 缺省清空）。
      // audioPath 是相对路径（media/s/<key>.mp3），客户端自己拼 httpBase 下载后本地播；
      // url 保留原始直链作兼容（客户端有 audioPath 时优先用它）。
      const audioPath = mediaPath ? mediaPath.replace(/^\//, '') : undefined
      this.deps.send({
        type: 'media.play',
        url: audioUrl,
        title,
        source: 'tts',
        ...(audioPath ? { audioPath } : {}),
        ...(image ? { cover: image } : {}),
      })
      // 记住这次播的百科，供「重新播放」原样重播（不重新查百度、不找歌）。
      this.lastTtsMedia = { url: audioUrl, title, ...(audioPath ? { audioPath } : {}), ...(image ? { cover: image } : {}), lines: subtitleLines }
      this.ttsMediaActive = true // 百科音频在播，「暂停/停掉」要认它
    } catch {
      // getaudio 是百度非公开接口，失败就不播——不用网关文字转语音兜底（用户明确不要自己合成）。
      // 只补 llm.done 收尾思考态，避免卡在「思考中」；字幕/封面都没下发，界面保持原样。
      this.deps.send({ type: 'llm.done' })
    }
  }

  /**
   * 诗词/古文朗读直连（绕开 LLM）：走 edu 数据源（百度汉语原文 + 百度朗读音频），
   * 不让 LLM 自己背全文（用户明确「长文本不经过 LLM/TTS」）。文字进字幕面板、音频走 media.play，
   * 助手框只播一句简短确认。提不到作品 sid 就诚实回退 LLM（受 ≤100 字闸门约束）。
   */
  /** @returns 是否命中并处理（没查到返回 false，交回调用方走 LLM） */
  private async runPoemCommand(title: string | null): Promise<boolean> {
    if (!title) {
      await this.speakReply(this.lang.toLowerCase().startsWith('en') ? 'Which poem would you like?' : '想背哪首？说个诗词名，比如「背诵滕王阁序」。')
      return true
    }
    const query = this.deps.poemQuery ?? ((t: string) => queryPoem(t))
    let entry: PoemEntry | null = null
    try {
      entry = await query(title)
    } catch {
      entry = null
    }
    if (!entry) {
      // 没查到（百度搜索无该作品 aladdin 卡片）：明确告知没找到，不再往下走别的直连分支
      // （否则「背诵回乡偶书」会被后面的好价分支抢走、答非所问），也不让 LLM 自己背全文。
      await this.speakReply(
        this.lang.toLowerCase().startsWith('en')
          ? `Sorry, I couldn't find "${title}".`
          : `暂时没找到《${title}》的诗词内容。`
      )
      return true
    }
    // edu 数据源把识别词纠成规范标题（如"滕王格世"→"滕王阁序"）：同音错字对自动学进词表
    void this.autoLearnCorrection(title, entry.title)
    // 与百科同理：先落盘音频拿真实时长，再按字数比例铺字幕 time（固定 3.2 秒/行会走太快/太慢）。
    let durationSec = 0
    let mediaPath: string | null = null
    if (entry.audioUrl) {
      mediaPath = await (this.deps.mediaCache ?? cacheExternalAudio)(entry.audioUrl)
      if (mediaPath) durationSec = getCachedAudioDuration(mediaPath)
    }
    const weights = entry.lines.map((t) => t.replace(/[，。！？、\s]/g, '').length)
    const totalWeight = weights.reduce((a, b) => a + b, 0)
    let acc = 0
    const lines = entry.lines.map((text, i) => {
      const line = { time: Math.round(acc * 10) / 10, text }
      acc += durationSec && totalWeight > 0 ? durationSec * weights[i] / totalWeight : 3.2
      return line
    })
    this.deps.send({ type: 'media.subtitle', title: entry.title, lines })
    if (entry.audioUrl) {
      // 第三方 mp3 直链直拉不稳，下发 local 短链 audioPath 走下载本地播。
      const audioPath = mediaPath ? mediaPath.replace(/^\//, '') : undefined
      this.deps.send({
        type: 'media.play',
        url: entry.audioUrl,
        title: entry.title,
        source: 'tts',
        ...(audioPath ? { audioPath } : {}),
      })
      // 记住这次播的诗词，供「重新播放」原样重播。
      this.lastTtsMedia = { url: entry.audioUrl, title: entry.title, ...(audioPath ? { audioPath } : {}), lines }
      this.ttsMediaActive = true // 诗词音频在播，「暂停/停掉」要认它
    }
    const confirm = this.lang.toLowerCase().startsWith('en')
      ? `Found "${entry.title}".`
      : `找到${entry.author ? entry.author + '的' : ''}《${entry.title}》，正在为你朗读。`
    await this.speakReply(confirm)
    return true
  }

  /**
   * 新闻播报直连（绕开 LLM）：抓真实新闻视频、抽音轨走 media.play 播放，不发文字合成音频。
   * 单条直接播；多条和音乐一样列编号候选让用户语音选一条（newsBvid 标记分流到新闻音轨）。
   */
  private async runNewsCommand(keyword: string | null): Promise<void> {
    const m = messages(this.lang).news
    // 新一轮新闻先清掉旧上下文：抓取失败时不留下过期列表，否则「下一条」会播上一批的残留。
    this.newsPlayback = null
    try {
      // 抓真实新闻视频候选（B 站），标题已清洗（去下划线/特殊符号）。音频不从文字合成。
      const hits = await this.newsVideoSource.search(keyword)
      const candidates = hits.slice(0, 3)
      if (!candidates.length) {
        await this.speakReply(m.none(keyword ?? undefined))
        return
      }
      // 记住本批候选（index=-1 表示还没开始播）：「下一条」据此接着切，不再掉进音乐点歌。
      this.newsPlayback = { items: candidates, index: -1, keyword }
      // 只有一条：直接抽这条的音轨播放，不必让用户选。
      if (candidates.length === 1) {
        await this.playNewsVideo(candidates[0])
        return
      }
      // 多条：和音乐一样列编号候选、让用户语音选一条（pendingCandidates + parseSelection）。
      // 候选项带 newsBvid，handleCandidateSelection 选中后据此走新闻音轨而非点歌。
      this.pendingCandidates = {
        items: candidates.map((c) => ({ title: c.title, artist: '', newsBvid: c.bvid, newsCover: c.cover })),
        query: keyword ?? '',
      }
      this.pendingDeals = null // 与商品候选互斥，「第二条」不能产生歧义
      await this.speakReply(m.candidates(candidates.map((c) => c.title)) + m.chooseHint())
    } catch {
      await this.speakReply(m.unavailable())
    }
  }

  /**
   * 播放一条选中（或唯一）的新闻视频：抽它的真实音轨 → 与音乐相同的 dash 短链下发。
   * 文本标题清洗后仅作为助手框显示 + 播放器标题，不做 TTS 合成。
   */
  private async playNewsVideo(candidate: { bvid: string; title: string; cover?: string }): Promise<void> {
    const m = messages(this.lang).news
    const video = await this.newsVideoSource.resolveBvid(candidate)
    if (!video?.url) {
      await this.speakReply(m.unavailable())
      return
    }
    const title = cleanNewsTitle(video.title) || candidate.title
    // 同步「正在播第几条」：后续「下一条」从这条往后切（选中多条候选时也会走到这里）。
    if (this.newsPlayback) {
      const idx = this.newsPlayback.items.findIndex((c) => c.bvid === candidate.bvid)
      if (idx >= 0) this.newsPlayback.index = idx
    }
    // 后台预热转封装（纯 JS fmp4→ADTS，无 ffmpeg），不阻塞 media.play；客户端取短链时等同一 key 完成。
    void ensureAdtsFile(video.url).catch(() => undefined)
    // 确认句走 speakReply：既在助手框显示、也 TTS 播报出来（同音乐点歌确认，用户要「有文字也要播报」）。
    // 不 await，避免阻塞 media.play（同 playTrack 模式）；llm.done 由 speakReply 内部收尾。
    void this.speakReply(messages(this.lang).news.playing(title))
    this.deps.send({
      type: 'media.play',
      url: '',
      title,
      ...(video.cover ? { cover: video.cover } : {}),
      audioPath: `music/s/${adtsKeyFor(video.url)}.aac`,
    })
  }

  /**
   * 新闻播放中用户说「播放下一条 / 换一条」：从当前下标的后一条接着抽音轨播放。
   * 播到最后一条就如实告知并清掉上下文，让用户再说「播放新闻」抓一批新的——
   * 不静默从头循环，否则用户分不清是重播还是真换了一条。
   */
  private async playNextNews(): Promise<void> {
    const ctx = this.newsPlayback
    if (!ctx?.items.length) return
    const next = ctx.index + 1
    if (next >= ctx.items.length) {
      this.newsPlayback = null
      await this.speakReply(messages(this.lang).news.noMore())
      return
    }
    await this.playNewsVideo(ctx.items[next])
  }

  /**
   * 处理「查商品 / 找好价」直接指令（绕开 LLM）：一次查询同时拿到口播文本与结构化 Deal[]。
   * 留住列表供下一轮语音选号；详情只走 media.detail 展示、不进 TTS；商品数据不进 voice.params。
   * dealsQuery 可由测试注入桩避免联网；缺省用 createDealsTool.snapshot（共用抓取缓存，零二次抓取）。
   */
  private async runDealsCommand(keyword?: string | null): Promise<void> {
    const query =
      this.deps.dealsQuery ??
      (async (): Promise<DealsSnapshot> => {
        // DealsOptions.source 必需（数据源由调用方注入，工具本身不绑定站点）。
        const primary = createDealsSource()
        const tool = createDealsTool(this.lang, {
          source: primary,
          // 内置源才补备用源（自动降级）；测试注入桩源不补
          fallbackSources: createDealsAllSources().some((s) => s.name === primary.name)
            ? createDealsAllSources().filter((s) => s.name !== primary.name)
            : [],
        })
        // 具体商品名（推荐一款空调）→ 带关键词走站内真搜索，能搜到普通商品、不限定好价；
        // 好价信号句（打折/优惠/便宜…）→ 限定好价 feed。
        // 多抓一些候选：下面要按长期记忆偏好挑 3 条，只取 3 条就没有挑选余地。
        return keyword
          ? tool.snapshot({ keyword, limit: 10 })
          : tool.snapshot({ limit: 10, dealsOnly: true })
      })
    try {
      const { text, deals } = await query(keyword)
      // 「推荐几件」按用户长期记忆里的偏好排序（确定性纯函数，不调 LLM）；
      // 没有记忆或都没命中时等价于取前 3 条，与没有个性化时行为一致。
      const picked = pickDeals(deals, await this.dealPreferenceKeywords(), 3)
      const m = messages(this.lang).deals
      if (picked.length) {
        // 有结果：记住候选供选号、下发编号列表卡片（全量快照），口播编号让用户选。
        this.pendingDeals = { items: picked, query: '' }
        this.deps.send({ type: 'media.detail', kind: 'deals', items: toDetailItems(picked, this.lang) })
        const spoken = `${m.candidates(picked.map((d) => d.title))}${m.chooseHint()}`
        await this.speakReply(spoken)
      } else {
        // 没找到：清除旧卡片（close）、清掉候选列表，只如实口播兜底，
        // 不下发空 items 快照（否则前端显示空的「为你找到」框）。
        this.pendingDeals = null
        this.deps.send({ type: 'media.detail', kind: 'deals', items: [], close: true })
        await this.speakReply(text)
      }
    } catch {
      await this.speakReply(formatDeals(this.lang, []))
    }
  }

  /** 读长期记忆抽商品偏好关键词；没有记忆或读取失败就返回空（不做个性化，行为同以前）。 */
  private async dealPreferenceKeywords(): Promise<string[]> {
    try {
      const entries = (await this.memoryStore?.list()) ?? []
      return preferenceKeywords(entries)
    } catch {
      return []
    }
  }

  /**
   * 处理用户对商品编号列表的语音选择。返回 true 表示这句已被消费。
   * 同 handleCandidateSelection，必须在回声比对之前调用：「第二个」正是刚口播过的词，
   * 否则会被 resemblesSpoken 当播报回声丢掉、永远选不中。
   * parseSelection 只读候选的 .title，用 {title, artist:''} 适配 Deal[]，零改动音乐模块。
   */
  private async handleDealSelection(text: string): Promise<boolean> {
    const pending = this.pendingDeals
    if (!pending || !pending.items.length) return false
    const idx = parseSelection(
      text,
      pending.items.map((d) => ({ title: d.title, artist: '' })),
    )
    if (idx === null) {
      // 卡片还在屏幕上，选号状态就不该丢：一句没说清的话不清列表，用户回头再说「第三件」仍要能选中。
      // 但「像是在报编号」却没对上（含糊 / 听错 / 越界）时，就地口播重问并消费这句，
      // 绝不放行到 LLM / 音乐直连，否则会被当成点歌或推荐歌曲，用户就再也选不回来了。
      if (looksLikeSelectionAttempt(text)) {
        this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })
        await this.speakReply(messages(this.lang).deals.chooseAgain())
        return true
      }
      return false
    }
    this.pendingDeals = null
    this.deps.send({ type: 'asr.final', text, queueRemaining: this.queue.length })

    // 先开口播确认（不复述商品内容），详情页补充信息与播报并行拉取：
    // 用户听到「已为你打开第 N 件」时卡片正好切过去，感知不到这次额外抓取。
    const spoken = this.speakReply(messages(this.lang).deals.detailIntro(idx + 1))
    const detail = await this.lookupDealDetail(pending.items[idx])
    // 源无关的补充信息合并进该条；合并后仍走同一个 toDetailItems 映射成统一 fields[]，
    // 客户端不知道详情来自列表页还是详情页、来自哪个站点。
    const items = detail
      ? pending.items.map((d, i) => (i === idx ? { ...d, ...detail } : d))
      : pending.items
    // 同一 kind 的全量快照 + selectedIndex（对应 DetailItem.index，1 起），客户端切成该商品详情。
    this.deps.send({
      type: 'media.detail',
      kind: 'deals',
      items: toDetailItems(items, this.lang),
      selectedIndex: idx + 1,
    })
    await spoken
    return true
  }

  /** 工具层下发的事件统一走这里透传客户端（商品/天气/时间等都是直连，不旁听）。 */
  /** LLM 工具（poemTool/baikeTool）路径刚下发的字幕行，供随后的 media.play(source:tts) 一并记入 lastTtsMedia。 */
  private toolPendingSubtitle: { title: string; lines: Array<{ time: number; text: string }> } | null = null

  private readonly emitToClient = (m: ServerEvent): void => {
    // LLM 工具路径的 tts 媒体也纳入状态管理：之前只有直连(runPoemCommand/runBaikeCommand)记
    // ttsMediaActive/lastTtsMedia，LLM 直接说作品名走 query_poem 工具时不记 → 「暂停/停止」说没在播、
    // 「重新播放」找不到。这里在统一出口补记（直连走 deps.send 不经此，不会重复）。
    if (m.type === 'media.subtitle' && !m.close) {
      this.toolPendingSubtitle = { title: m.title, lines: m.lines }
    } else if (m.type === 'media.play' && m.source === 'tts') {
      const lines = this.toolPendingSubtitle?.title === m.title ? this.toolPendingSubtitle.lines : []
      this.lastTtsMedia = {
        url: m.url, title: m.title,
        ...(m.audioPath ? { audioPath: m.audioPath } : {}),
        ...(m.cover ? { cover: m.cover } : {}),
        lines,
      }
      this.ttsMediaActive = true
      this.toolPendingSubtitle = null
    }
    this.deps.send(m)
  }

  /** 补抓选中商品的详情页；任何失败都返回 null，卡片退回列表数据照常展示。 */
  private async lookupDealDetail(deal: Deal): Promise<DealDetail | null> {
    if (!deal) return null
    const lookup = this.deps.dealsDetail ?? ((d: Deal) => enrichDeal(createDealsSource(), d))
    try {
      return await lookup(deal)
    } catch {
      return null
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
        this.deps.send({ type: 'tts.end' })
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
      this.deps.send({ type: 'tts.end' })
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
    const cleanChunk = this.aecActive ? this.aec.process(chunk) : chunk
    // VAD/ASR 用消除回声后的帧，与思考/空闲期同一套门槛，不加 strict。
    const vad = this.vad.push(cleanChunk)
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
    if (!Number.isFinite(speechDuration) || speechDuration < 0 || speechDuration >= 0.6) return false
    const t = text.trim()
    // 多字句一律放行：真人正常说话/选号（第二首）都是多字，打嗝幻觉是单字或纯数字。
    // 注意纯数字单独处理（见下）——「8」既可能是选号也可能是打嗝幻觉，靠上下文区分。
    if (Array.from(t).length > 1 && !/^\d+$/.test(t)) return false
    // 命中任何已知有效意图 → 放行（音乐/诗词/百科/音量/字幕/记忆/时间/天气/新闻/商品/好价）
    if (
      detectMusicCommand(t) || detectPoemCommand(t) || detectBaikeCommand(t) ||
      detectVolumeCommand(t) || detectSubtitleCommand(t) || detectMemoryCommand(t) ||
      isTimeQuery(t) || detectWeatherCommand(t) || detectNewsCommand(t) ||
      detectProductQuery(t) || detectDealsCommand(t) || detectPlayModeCommand(t)
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
    if (this.isHallucinationShort(text, this.asr.speechDuration ?? -1, !!(this.pendingCandidates || this.pendingDeals))) {
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
    if (this.pendingCandidates && await this.handleCandidateSelection(text)) return
    // 上一轮给过商品编号列表，这一句优先当作「说编号 / 点商品名」解析。
    // 同样必须早于回声比对：「第二个」正是刚口播过的词。
    if (this.pendingDeals && await this.handleDealSelection(text)) return

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
    // 避免被丢给大模型由 play_music 自动播放（破坏「按歌手浏览要给候选列表让用户选」）。
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
    this.deps.send({ type: 'asr.final', text: next, queueRemaining: this.queue.length })
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
        } else this.cancelPlaybackWait()
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
        this.deps.send({ type: 'asr.final', text: next, queueRemaining: this.queue.length })
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
      }
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
        // 播完（或超时）后关闭回声门控窗口，并恢复 duck 的播报音量（兜底）
        this.playbackPending = false
        if (this.duckReleaseTimer) {
          clearTimeout(this.duckReleaseTimer)
          this.duckReleaseTimer = null
        }
        this.setDuck(false)
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
    // skipRequested 也视为「当前句已作废」：停止后续 delta 下发与 enqueue，
    // 但不清队列、不 ++turn，runTurn 的链得以继续播队首下一句。
    const stale = () => this.turn !== turn || this.cancelled || this.skipRequested
    let buffer = ''
    let ttsStarted = false
    let ttsChain: Promise<void> = Promise.resolve()
    let timedOut = false
    // 长文本不经过 LLM/TTS：LLM 自由回答累计超过上限就停止下发（工具返回的百科/好价/歌词
    // 不经过这里，不受限）。不硬切半句——只在句子边界停，超长部分不念（省流量+播报不过长）。
    const MAX_LLM_SPOKEN_CHARS = 100
    let emittedChars = 0
    let lengthCapped = false
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
    // 超时看门狗：上游 LLM 卡住/冷启动慢时，主动舍弃本轮流式增量、断开下行播放，
    // 立即播友好兜底，不让用户干等、也不暴露技术故障（用户：「不要让用户觉得好慢」）。
    const timeoutMs = this.deps.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    const replyPromise = this.agent.reply(
      text,
      (delta) => {
        if (stale() || timedOut || lengthCapped) return
        // 字数闸门：LLM 生成累计超限就停发（不硬切半句，本句播完即止）。
        if (emittedChars + delta.length > MAX_LLM_SPOKEN_CHARS) {
          emittedChars = MAX_LLM_SPOKEN_CHARS + 1
          lengthCapped = true
          return
        }
        emittedChars += delta.length
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
        this.deps.send({ type: 'llm.thinking', text: delta })
      }
    )
    // 超时后 replyPromise 仍在跑：挂个空 catch 避免产生未处理 rejection
    void replyPromise.catch(() => undefined)
    try {
      const full = await Promise.race([
        replyPromise,
        new Promise<string>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error('LLM_TIMEOUT')), timeoutMs)
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
      this.deps.send({ type: 'llm.done' })
      this.deps.data.insertCommandLog(this.deviceId, text, full.slice(0, 200))
      await ttsChain
      if (ttsStarted && !stale()) {
        this.speaking = false
        this.deps.send({ type: 'tts.end' })
      } else if (!ttsStarted && !stale()) {
        // 整句都不可念（大模型泄漏的控制符 / 空回复 / 只剩符号）：绝不当作正文念出来，
        // 给一句兜底口播，让人能自然重说一遍。兜底句有 TTS 下发，返回 true 让 runTurn
        // 等它播完回执再 shift 队列下一句。
        await this.speakReply(messages(this.lang).llmFallthrough())
        return true
      }
      return ttsStarted
    } catch {
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
    this.spoken.push(sentence)
    // 只留最近几句：回声延迟有限，太久以前的文本不该再参与比对
    if (this.spoken.length > 6) this.spoken.shift()
    const gapMs = this.deps.ttsFrameGapMs ?? 15_000
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
      this.resolvePlayback()
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
            this.resolvePlayback()
          }
          break
        }
        const frame = next.value
        gotAnyFrame = true
        if (this.turn !== turn || this.cancelled || this.skipRequested) return
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
      this.resolvePlayback()
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
    try {
      const { appendFileSync } = await import('node:fs')
      const home = process.env.GATEWAY_HOME ?? '.'
      appendFileSync(
        `${home}/gateway-debug.log`,
        `${new Date().toISOString()} probe down=${JSON.stringify(down)} report=${JSON.stringify(report)}\n`,
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
      // 本轮对话历史随旧 agent 作废可接受。重建前先关掉旧 MCP 客户端（stdio 子进程 / 网络连接）。
      await this.agent?.closeMcp?.()
      this.agent = mode === 'wake'
        ? null
        : await this.deps.agentFactory(
            resolved.llm,
            lang,
            this.timezone,
            () => this.getLocation(),
            () => this.musicSource,
            this.emitToClient,
            this.memoryStore,
            this.memoryContext,
            () => this.requestClientLocation(),
            this.autoSubtitle,
            this.defaultLoop,
            this.defaultVolume,
            this.autoLoop,
            this.dealsCount,
            () => (this.musicActive && this.lastTrack ? { title: this.lastTrack.title, artist: this.lastTrack.artist, contentType: this.lastTrack.contentType } : null),
            this.autoMemory,
            this.mcpServers,
            this.deps.correctionSyncer?.engine,
            this.skillPromptAddon
          )
      this.lastLlmKey = llmKey
      return
    }

    // 全新会话：清空跨轮状态并重建 LLM（重武装/re-arm 走上面的早返回，不清商品候选）
    this.pendingCandidates = null
    this.pendingDeals = null
    this.pendingNextFallback = false
    this.newsPlayback = null
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
            () => this.musicSource,
            this.emitToClient,
            memoryStore,
            memoryContext,
            () => this.requestClientLocation(),
            this.autoSubtitle,
            this.defaultLoop,
            this.defaultVolume,
            this.autoLoop,
            this.dealsCount,
            () => (this.musicActive && this.lastTrack ? { title: this.lastTrack.title, artist: this.lastTrack.artist, contentType: this.lastTrack.contentType } : null),
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
    this.cancelPlaybackWait()
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
    this.cancelPlaybackWait()
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
    this.pendingCandidates = null
    this.pendingDeals = null
    this.pendingNextFallback = false
    this.newsPlayback = null
    this.finalizeChain = Promise.resolve()
    this.cancelPlaybackWait()
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
