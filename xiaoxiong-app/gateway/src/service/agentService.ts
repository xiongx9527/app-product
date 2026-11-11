import { Agent } from '@agentscope-ai/agentscope/agent'
import {
  OpenAIChatModel,
} from '@agentscope-ai/agentscope/model'
import type { ChatModelBase } from '@agentscope-ai/agentscope/model'
import { UserMsg } from '@agentscope-ai/agentscope/message'
import { EventType } from '@agentscope-ai/agentscope/event'
import { messages } from '../i18n'
import type { Lang } from '../protocol'
import type { LlmConfig } from '../config'
import { createToolkit, type LocationProvider, type MediaEmitter, type MemoryStore, type RequestLocation } from './tools'
import type { MusicSource } from './music/types'
import { ChannelSplitter } from './channelSplitter'

/** 对话智能体服务：按语言本地化系统提示，流式回传文本增量。 */
export interface AgentService {
  reply(
    userText: string,
    onDelta: (delta: string) => void,
    onThinking?: (delta: string) => void
  ): Promise<string>
}

/** 按配置构造真实的 LLM 模型实例（AgentScope 提供的各厂商实现）。 */
function createModel(cfg: LlmConfig): ChatModelBase {
  const { provider, baseUrl, model, apiKey, params } = cfg
  switch (provider) {
    case 'builtin':
      // 内置：本地 AI 服务的 OpenAI 兼容层（/llm/v1 纯转发到任意上游），统一走 OpenAI 兼容接口。
      // 本地服务不校验 key，apiKey 为空时用占位符，避免 OpenAI SDK 在构造时因缺凭证抛错拖垮进程。
      return new OpenAIChatModel({
        modelName: model,
        apiKey: apiKey || 'builtin-local',
        baseURL: baseUrl || undefined,
        stream: true,
        presetGenParams: params,
      })
    case 'dashscope':
      // 走 OpenAI 兼容层并显式带上 baseURL：这样用户填的「服务地址」（如自建 MAAS 实例
      // https://llm-xxx.maas.aliyuncs.com）才会真正被用上。DashScopeChatModel 不带 baseURL
      // 参数，只会打阿里云云端、无视用户配置，导致自定义端点（MAAS）「模型异常」。
      // 阿里云兼容模式与通用 OpenAI 兼容，OpenAIChatModel + baseURL 对云端 / 自定义端点一致生效。
      return new OpenAIChatModel({ modelName: model, apiKey, baseURL: baseUrl || undefined, stream: true, presetGenParams: params })
    default:
      throw new Error(`不支持的 LLM 提供方：${provider as string}`)
  }
}

export function createAgentService(
  config: { llm: LlmConfig; timeZone?: string },
  lang: Lang,
  locationProvider: LocationProvider = () => null,
  getMusicSource?: () => MusicSource | undefined,
  emit?: MediaEmitter,
  memoryStore?: MemoryStore,
  memoryContext?: string,
  requestLocation?: RequestLocation,
  autoSubtitle?: boolean,
  defaultLoop?: number,
  defaultVolume?: number,
  autoLoop?: boolean,
  getNowPlaying?: () => { title: string; artist?: string; contentType?: string } | null
): AgentService {
  if (config.llm.provider === 'stub') return new StubAgentService()
  const model = createModel(config.llm)
  const m = messages(lang)
  // 把该设备已记住的内容拼进系统提示（memoryContext 由会话层按 deviceId 加载并格式化），
  // 让助手在唤醒后自然参考用户习惯，而不是每次都从零开始问。无记忆时为空串，不影响原提示。
  const baseSysPrompt = m.systemPrompt + (memoryContext ?? '')
  const agent = new Agent({
    name: 'Xiong',
    sysPrompt: baseSysPrompt,
    model,
    toolkit: createToolkit(lang, config.timeZone, locationProvider, getMusicSource, emit, memoryStore, requestLocation, autoSubtitle, defaultLoop, defaultVolume, autoLoop),
  })
  // 当前播放曲目动态拼进系统提示：每轮 reply 前按最新曲目刷新，让助手能回答
  // 「现在播的什么歌 / 谁唱的」，而不必回「不知道」。Agent 只在 reply 时读 this.sysPrompt，
  // 这里更新其底层字段即可（不重建 Agent，避免丢失多轮对话上下文）。
  function refreshNowPlaying(): void {
    const now = getNowPlaying?.()
    const ctx = now ? m.nowPlayingContext(now.title, now.artist, now.contentType) : ''
    ;(agent as unknown as { _sysPrompt: string })._sysPrompt = baseSysPrompt + ctx
  }
  return {
    async reply(userText, onDelta, onThinking) {
      refreshNowPlaying()
      const stream = agent.replyStream({ msgs: UserMsg({ name: 'user', content: userText }) })
      // 推理模型会把思考过程连同控制符当作普通文本流下发，这里按 channel 拆开：
      // 思考走 onThinking（不进 TTS），最终答案走 onDelta。
      let full = ''
      const splitter = new ChannelSplitter(
        (s) => {
          full += s
          onDelta(s)
        },
        (s) => onThinking?.(s)
      )
      for await (const ev of stream) {
        if (ev.type === EventType.TEXT_BLOCK_DELTA) {
          splitter.push(ev.delta)
        } else if (ev.type === EventType.THINKING_BLOCK_DELTA) {
          // 思考过程只用于界面展示，不参与回复正文与 TTS
          onThinking?.(ev.delta)
        }
      }
      splitter.end()
      return full
    },
  }
}

/** 离线测试用 LLM：不联网，返回本地拼接的回包，便于在 CI / 无 Ollama 环境跑通语音流。 */
class StubAgentService implements AgentService {
  async reply(
    userText: string,
    onDelta: (delta: string) => void,
    onThinking?: (delta: string) => void
  ): Promise<string> {
    onThinking?.('（离线模式）先想一下该说什么。')
    const reply = `（离线回包）你刚才说：「${userText}」。这是本地 AgentScope 网关的离线回复，接上真实 LLM 后即为真实回答。`
    for (const piece of chunk(reply, 5)) {
      onDelta(piece)
      await delay(15)
    }
    return reply
  }
}

function chunk(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
