import { Agent } from '@agentscope-ai/agentscope/agent'
import {
  OpenAIChatModel,
  DashScopeChatModel,
  DeepSeekChatModel,
} from '@agentscope-ai/agentscope/model'
import type { ChatModelBase } from '@agentscope-ai/agentscope/model'
import { UserMsg } from '@agentscope-ai/agentscope/message'
import { EventType } from '@agentscope-ai/agentscope/event'
import { messages } from '../i18n'
import type { Lang } from '../protocol'
import type { LlmConfig } from '../config'

/** 对话智能体服务：按语言本地化系统提示，流式回传文本增量。 */
export interface AgentService {
  reply(userText: string, onDelta: (delta: string) => void): Promise<string>
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
    case 'dashscope':
      return new DashScopeChatModel({ modelName: model, apiKey, stream: true, presetGenParams: params })
    case 'deepseek':
      return new DeepSeekChatModel({ modelName: model, apiKey, stream: true, presetGenParams: params })
    default:
      throw new Error(`不支持的 LLM 提供方：${provider as string}`)
  }
}

export function createAgentService(config: { llm: LlmConfig }, lang: Lang): AgentService {
  if (config.llm.provider === 'stub') return new StubAgentService()
  const model = createModel(config.llm)
  const agent = new Agent({ name: 'Xiong', sysPrompt: messages(lang).systemPrompt, model })
  return {
    async reply(userText, onDelta) {
      const stream = agent.replyStream({ msgs: UserMsg({ name: 'user', content: userText }) })
      let full = ''
      for await (const ev of stream) {
        if (ev.type === EventType.TEXT_BLOCK_DELTA) {
          onDelta(ev.delta)
          full += ev.delta
        }
      }
      return full
    },
  }
}

/** 离线测试用 LLM：不联网，返回本地拼接的回包，便于在 CI / 无 Ollama 环境跑通语音流。 */
class StubAgentService implements AgentService {
  async reply(userText: string, onDelta: (delta: string) => void): Promise<string> {
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
