import { Agent } from '@agentscope-ai/agentscope/agent'
import {
  OpenAIChatModel,
  OllamaChatModel,
  DashScopeChatModel,
  DeepSeekChatModel,
} from '@agentscope-ai/agentscope/model'
import type { ChatModelBase } from '@agentscope-ai/agentscope/model'
import { UserMsg } from '@agentscope-ai/agentscope/message'
import { EventType } from '@agentscope-ai/agentscope/event'
import { messages } from '../i18n'
import type { Lang } from '../protocol'
import type { LlmConfig } from '../config'
import { createToolkit, type LocationProvider, type ReverseGeocoder, type MediaEmitter, type MemoryStore } from './tools'
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
    case 'openai':
      // OpenAI 兼容端点：本地 Ollama 的 /v1 也走这里（baseUrl 指向对应 endpoint）。
      return new OpenAIChatModel({
        modelName: model,
        apiKey,
        baseURL: baseUrl || undefined,
        stream: true,
        presetGenParams: params,
      })
    case 'ollama':
      // 原生 /api/chat：只有它能透出模型的思考过程，OpenAI 兼容层会丢弃 reasoning。
      return new OllamaChatModel({
        modelName: model,
        // 配置里可能写成 http://host:11434/v1，原生接口不接受 /v1 后缀
        host: baseUrl ? baseUrl.replace(/\/v1\/?$/, '') : undefined,
        stream: true,
        options: params,
        thinkingConfig: { enableThinking: true, thinkingLevel: 'low' },
      })
    case 'dashscope':
      return new DashScopeChatModel({ modelName: model, apiKey, stream: true, presetGenParams: params })
    case 'deepseek':
      return new DeepSeekChatModel({ modelName: model, apiKey, stream: true, presetGenParams: params })
    default:
      throw new Error(`不支持的 LLM 提供方：${provider as string}`)
  }
}

export function createAgentService(
  config: { llm: LlmConfig; timeZone?: string },
  lang: Lang,
  locationProvider: LocationProvider = () => null,
  reverseGeocoder?: ReverseGeocoder,
  musicSource?: MusicSource,
  emit?: MediaEmitter,
  memoryStore?: MemoryStore,
  memoryContext?: string
): AgentService {
  if (config.llm.provider === 'stub') return new StubAgentService()
  const model = createModel(config.llm)
  const m = messages(lang)
  // 把该设备已记住的内容拼进系统提示（memoryContext 由会话层按 deviceId 加载并格式化），
  // 让助手在唤醒后自然参考用户习惯，而不是每次都从零开始问。无记忆时为空串，不影响原提示。
  const sysPrompt = m.systemPrompt + (memoryContext ?? '')
  const agent = new Agent({
    name: 'Xiong',
    sysPrompt,
    model,
    toolkit: createToolkit(lang, config.timeZone, locationProvider, reverseGeocoder, musicSource, emit, memoryStore),
  })
  return {
    async reply(userText, onDelta, onThinking) {
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
