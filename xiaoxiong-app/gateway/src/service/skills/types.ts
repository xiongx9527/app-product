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

/** 网关在每轮会话 start 时构造、注入给 skill 的运行时能力。 */
export interface SkillContext {
  lang: Lang
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

/** 每会话一个实例；状态放闭包里，天然按会话隔离。 */
export interface Skill {
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
