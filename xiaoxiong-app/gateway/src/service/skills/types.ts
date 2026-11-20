/**
 * 可插拔 Skill 机制的类型契约。
 *
 * 业务规则（如「用户说喜欢 X → 先回答、播完后追问要不要记」）不再写死在
 * systemPrompt 或会话编排的 if 里，而是做成独立 skill 单元，统一实现这里的
 * 生命周期接口，由 registry 登记、loader 按配置启用、网关在对应时机调用。
 *
 * 与 tools/ 的区别：skill 是「会话行为 + 提示词片段」的胶囊，带状态、接事件；
 * tool 是「LLM 可调用的函数」，无状态。两者互补。
 */
import type { Lang, ServerEvent } from '../../protocol'
import type { DataService } from '../dataService'
import type { MemoryStore } from '../tools'
import type { AgentService } from '../agentService'
import type { MediaPlaybackCapability } from '../media/mediaPlaybackCapability'
import type { ContentCandidate } from '../content/types'
import type { LocationInfo } from '../../protocol'

/** 网关在每轮会话 start 时构造、注入给 skill 的运行时能力。 */
export interface SkillContext {
  lang: Lang
  /** 会话时区（时间 skill 用），来自 session.start.timezone，缺省东八区。 */
  timezone: string
  deviceId: string | null
  data: DataService
  memoryStore: MemoryStore | undefined
  /** 当前会话的 LLM 智能体；wake 模式下为 null（此时不做记忆抽取）。 */
  agent: AgentService | null
  send: (event: ServerEvent) => void
  /** 口播一句（走网关 TTS 链路，含界面显示）。 */
  speak: (text: string) => Promise<void>
  /** 当前排队剩余句数，用于 asr.final 的 queueRemaining 字段。 */
  queueRemaining: () => number

  /**
   * 系统能力：媒体播放（预热/短链/下发/状态机），纯机制、不含业务、不含数据源。
   * skill 只把定好的 MediaAsset 交给它播放，不直接发 media.* 事件。
   * 数据源的定义/默认实现放在各 skill 自己的目录内、可注入替换——换源只换注入的实现，
   * skill 代码零改动；源相关的东西不进这个全局契约文件。
   */
  media?: MediaPlaybackCapability

  /**
   * 定位系统能力（懒加载）：天气等需要位置时用。不是"源"，是设备能力。
   * 用户从不问位置相关问题时全程不触碰定位、不弹权限框。
   */
  getLocation?: () => LocationInfo | null
  requestClientLocation?: () => Promise<LocationInfo | null>

  /**
   * 内容播放请求回调（点歌/换一首/推荐/选号）。内容型 skill（音乐/新闻）在识别意图后
   * 通过这些回调请求核心执行「取媒体+列候选+选号」——这些逻辑依赖跨轮状态与数据源，
   * 由核心/能力层持有，skill 只负责识别+传参+口播。语义通用，不含具体业务类型。
   */
  content?: {
    /** 点播：text 为用户原话，返回是否已处理。 */
    play: (text: string) => Promise<boolean>
    /** 换一首/下一条。 */
    next: (text: string) => Promise<boolean>
    /** 推荐列表。 */
    recommend: (text: string) => Promise<boolean>
    /** 选第几条（跨轮候选）。 */
    select: (text: string) => Promise<boolean>
    /** 挂起候选列表（多条结果时口播编号让用户语音选，跨音乐/新闻共用）。 */
    setCandidates: (items: ContentCandidate[], query: string) => void
    /** 与商品候选互斥：挂内容候选时清掉商品候选。 */
    clearDeals: () => void
  }

  /**
   * 通用内容能力（系统能力，非某业务所有）：外部音频落本地短链 + 真实时长、dash 短链工具，
   * 由装配层注入。百科/诗词/新闻等需要「播真实音频+同源字幕」的 skill 共用，不各自实现。
   */
  mediaTools?: {
    /** 第三方音频落本地短链；失败返回 null（回退原 url）。 */
    cacheAudio: (url: string) => Promise<string | null>
    /** 已落盘音频的真实时长（秒）；拿不到返回 0（回退估算）。 */
    audioDuration: (path: string) => number
    /** dash 音轨后台预热（不 await）。 */
    ensureAdts: (raw: string) => Promise<string>
    /** dash 短链 key。 */
    adtsKey: (raw: string) => string
  }

  /** 记住本次「文字转音频」媒体供「重新播放」（百科/诗词）：跨业务状态，核心持有。 */
  rememberTtsMedia?: (media: {
    url: string; title: string; audioPath?: string; cover?: string
    lines: Array<{ time: number; text: string }>
  }) => void

  /** ASR 同音纠错学习（数据源把识别词纠成规范词时调用）：跨业务能力，核心持有。 */
  autoLearn?: (wrong: string, correct: string) => void
  /** 读设备长期记忆里的偏好关键词。好价据此排序、音乐/新闻/诗词/百科在无明确内容时据此推荐候选。 */
  getPreferenceKeywords?: () => Promise<string[]>
}

/** 一句定稿后 skill 的处理结果。 */
export interface FinalizeResult {
  /** true = 这句已被本 skill 消费，网关不再走后续直连命令 / LLM。 */
  consumed?: boolean
}

/** LLM 文本收尾后 skill 的处理结果。 */
export interface AgentReplyResult {
  /** 要拼进同一条 TTS 链的追问文本（无停顿），网关按 skill 顺序拼接下发。 */
  appendTts?: string
}

/** 一句直连意图的处理结果。 */
export interface DirectCommandResult {
  /** true = 这句已被本 skill 当作直连意图消费，网关不再走后续 skill / LLM。 */
  consumed?: boolean
}

/** 每会话一个实例；状态放闭包里，天然按会话隔离。 */
export interface Skill {
  /**
   * 这句短语音是否是本 skill 的有效意图（纯识别、不执行、不产生副作用）。
   * 网关的幻觉兜底用它做「有效意图白名单」：极短语音命中任一 skill 意图即放行，
   * 否则当打嗝/吸鼻子的 ASR 幻觉丢弃。业务判断归各 skill，网关不 import 具体 detect。
   */
  matchesIntent?(text: string): boolean
  /**
   * 裸内容查询兜底（如只报一个歌手/作品名「周杰伦」「稻香」，无可辨识动词）。
   * 网关在直连命令与选号都未命中时按序询问；返回 true 表示已消费。
   * 这样网关不 import 具体 skill 的裸查询识别逻辑。
   */
  onBareQuery?(text: string): Promise<boolean>
  /**
   * 播放「外部视频音轨」（新闻等）：用户语音选中一条带 bvid 的候选后，通用执行器据此回调本 skill
   * 抽音轨下发。返回 true 表示本 skill 处理了这条。网关不 import 具体 skill。
   */
  playExternalVideo?(c: { bvid?: string; title: string; cover?: string }): Promise<boolean>
  /** 通用媒体 stop 时通知：清掉本 skill 的跨轮播放上下文（如新闻待选列表）。 */
  onMediaStop?(): void
  /** 本 skill 是否挂起了一组「语音报号可选」的候选（幻觉判断据此放行单字数字）。 */
  hasCandidates?(): boolean
  /** 定稿时语音选择本 skill 的候选（如商品「第二个」）；须早于回声比对调用。返回 true=已消费。 */
  onCandidateSelection?(text: string): Promise<boolean>
  /** 清掉本 skill 挂起的候选（与内容候选互斥：设音乐候选时清商品候选）。 */
  clearCandidates?(): void
  /**
   * 直连意图处理（绕开 LLM）：按网关固定顺序调用，先识别再执行。
   * 业务规则（detect+run+源适配）都在本 skill 内；返回 consumed=true 表示已处理。
   * 顺序由网关的 DIRECT_SKILL_ORDER 固定，不由 enabled 配置决定（防配错回归）。
   */
  onDirectCommand?(text: string): Promise<DirectCommandResult | void>
  /** 一句定稿时调用（空闲定稿 + 队列回放都调），做确认/暂存。 */
  onFinalize?(text: string): Promise<FinalizeResult | void>
  /** LLM 流式回复收尾时调用（同步），可返回拼进同一 TTS 链的追问。 */
  onAgentReply?(text: string, full: string): AgentReplyResult | void
  /** 一句真正播完后调用，做兜底追问。 */
  onAfterSpeak?(text: string): Promise<void>
  /** 会话取消/结束/重新开始（重武装）时调用，清掉 skill 内部状态。 */
  onSessionReset?(reason: 'cancel' | 'end' | 'start'): void
}

/** 无状态工厂：注册表持有它，每会话 create 出一个带状态的 Skill 实例。 */
export interface SkillModule {
  /** 唯一标识（用于配置清单 enabled 白名单、日志）。 */
  id: string
  /** 可读名称（配置清单 / 日志展示，便于看懂每个 skill 是干嘛的）。 */
  name: string
  /**
   * 直连意图匹配优先级（数字越小越先）。
   * 网关按 priority 升序调度 onDirectCommand——先识别的先消费，命中即短路。
   * 顺序由 skill 自己声明（不是网关硬编码数组），新增/调整 skill 不用改编排层。
   * 约定间隔 10（10/20/30…）便于插入新 skill。用途不同的 skill 不要给相同值。
   */
  priority: number
  /**
   * 能力描述（按语言）——自动作为提示词片段注入 systemPrompt，
   * 让 LLM 知道本助手挂载了哪些 skill 能力（与 tools 的 description 同思路）。
   * 返回空串表示该 skill 不需要向 LLM 暴露提示词（纯代码钩子型）。
   */
  description(lang: Lang): string
  /** 每会话构造实例。 */
  create(ctx: SkillContext): Skill
}

/**
 * 把所有启用 skill 的 description 汇总成一段 systemPrompt 追加文本（按语言）。
 * 纯函数，便于单测；空描述不产生多余空白。
 */
export function skillPromptAddon(modules: readonly SkillModule[], lang: Lang): string {
  return modules
    .map((m) => m.description(lang).trim())
    .filter(Boolean)
    .join('\n')
}
