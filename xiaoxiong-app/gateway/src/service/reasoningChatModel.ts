/**
 * 支持 DeepSeek / 通义风格 reasoning_content 的 OpenAI 兼容模型。
 *
 * 背景：9529 的 /llm/v1 把各厂商思考统一成 SSE `choices[0].delta.reasoning_content`
 * （Ollama thinking、Anthropic thinking、DeepSeek 原生 reasoning 都映射到这个字段）。
 * 但 AgentScope 自带的 OpenAIChatModel 的 `_parseOpenAIStreamedResponse` 只读
 * `delta.content`，把 reasoning_content 整帧丢掉 → 思考框永远不显示。
 *
 * 本类继承 OpenAIChatModel，仅覆盖流式解析：复制父类循环，唯一改动是在读 delta.content
 * 的同时也读 delta.reasoning_content，并把它转成 AgentScope 认识的 `type:'thinking'` block
 * （Agent 会 emit 成 THINKING_BLOCK_DELTA → 网关发 llm.thinking → 前端显示思考框）。
 * 其余（tool_calls / usage / 最终块）与父类一致，避免行为漂移。
 *
 * 参数用 any：reasoning_content 是 OpenAI 扩展字段，不在第三方 ChatCompletionChunk 的
 * 官方类型定义里；这里是刻意处理该扩展字段，不是掩盖 bug。
 */
import { OpenAIChatModel } from '@agentscope-ai/agentscope/model'

type DeltaBlock = { type: string; [k: string]: unknown }

export class ReasoningChatModel extends OpenAIChatModel {
  // 覆盖父类同名方法（覆盖是隐式发生的，不加 override 以避开第三方严格签名不匹配）。
  async *_parseOpenAIStreamedResponse(
    stream: AsyncIterable<any>,
    startTime: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncGenerator<any, any, any> {
    // 复用父类的块转换方法（protected，子类可读），避免重复实现。
    const toBlocks = (this as unknown as {
      _accDataToBlocks: (text: string, toolCalls: Map<string, DeltaBlock>) => DeltaBlock[]
    })._accDataToBlocks.bind(this)

    let accText = ''
    let accThinking = ''
    const accToolInputs = new Map<string, string>()
    const toolCallMeta = new Map<string, { id: string; name: string }>()
    let lastUsage: unknown = null
    let responseId = ''
    let createdTimestamp = 0

    for await (const chunk of stream) {
      if (!responseId && chunk.id) responseId = chunk.id
      if (!createdTimestamp && chunk.created) createdTimestamp = chunk.created
      if (chunk.choices && chunk.choices.length > 0) {
        const choice = chunk.choices[0]
        let deltaText = ''
        let deltaThinking = ''
        const deltaToolCalls = new Map<string, DeltaBlock>()
        // ——唯一本质改动：同时读 reasoning_content——
        if (choice.delta?.content) {
          deltaText = choice.delta.content
          accText += deltaText
        }
        if (choice.delta?.reasoning_content) {
          deltaThinking = choice.delta.reasoning_content
          accThinking += deltaThinking
        }
        if (choice.delta?.tool_calls) {
          choice.delta.tool_calls.forEach((toolCall: { index: number; id?: string; function?: { name?: string; arguments?: string } }) => {
            const index = toolCall.index.toString()
            if (!toolCallMeta.has(index)) toolCallMeta.set(index, { id: '', name: '' })
            if (!accToolInputs.has(index)) accToolInputs.set(index, '')
            const meta = toolCallMeta.get(index)!
            if (toolCall.id) meta.id = toolCall.id
            if (toolCall.function?.name) meta.name = toolCall.function.name
            if (toolCall.function?.arguments) {
              const deltaArgs = toolCall.function.arguments
              accToolInputs.set(index, accToolInputs.get(index) + deltaArgs)
              deltaToolCalls.set(index, {
                type: 'tool_call',
                id: meta.id,
                name: meta.name,
                input: deltaArgs,
                state: 'pending',
                created_at: new Date().toISOString(),
              })
            }
          })
        }
        const deltaBlocks = toBlocks(deltaText, deltaToolCalls)
        // 思考块放正文块前面，Agent 逐个 emit（思考先于正文展示）。
        if (deltaThinking) {
          deltaBlocks.unshift({
            type: 'thinking',
            thinking: deltaThinking,
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
          })
        }
        yield {
          type: 'chat',
          id: responseId || crypto.randomUUID(),
          createdAt: createdTimestamp ? new Date(createdTimestamp * 1e3).toISOString() : new Date().toISOString(),
          content: deltaBlocks,
          usage: lastUsage,
        }
      }
      if (chunk.usage) {
        lastUsage = {
          type: 'chat_usage',
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0,
          time: (Date.now() - startTime) / 1e3,
        }
      }
    }
    const finalToolCalls = new Map<string, DeltaBlock>()
    toolCallMeta.forEach((meta, index) => {
      finalToolCalls.set(index, {
        type: 'tool_call',
        id: meta.id,
        name: meta.name,
        input: accToolInputs.get(index) || '{}',
        state: 'pending',
        created_at: new Date().toISOString(),
      })
    })
    const blocks = toBlocks(accText, finalToolCalls)
    if (accThinking) {
      blocks.unshift({
        type: 'thinking',
        thinking: accThinking,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
      })
    }
    return {
      type: 'chat',
      id: responseId || crypto.randomUUID(),
      createdAt: createdTimestamp ? new Date(createdTimestamp * 1e3).toISOString() : new Date().toISOString(),
      content: blocks,
      usage: lastUsage,
    }
  }
}
