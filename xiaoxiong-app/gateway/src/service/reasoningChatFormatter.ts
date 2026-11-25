/**
 * 支持 DeepSeek「思考模式」多轮工具调用的消息格式化器。
 *
 * 背景：思考模式下，带 tool_calls 的 assistant 消息必须在下一轮请求里原样回传
 * reasoning_content，否则上游直接 400：
 * 「The `reasoning_content` in the thinking mode must be passed back to the API.」
 * 而 AgentScope 自带的 OpenAIChatFormatter / DeepSeekChatFormatter 都在
 * `case 'thinking': break;` 处把思考块丢掉 → 表现为「工具调用成功、模型却再没有任何输出」。
 *
 * 本类继承 OpenAIChatFormatter 复用文本/多模态块的格式化细节，只补一件事：
 * 把 assistant 消息里的 thinking 块汇总成 reasoning_content 字段。
 * 只对「带 tool_calls 的 assistant 消息」回传：这是上游要求的场景；普通问答轮不把
 * 历史推理链塞回上下文（DeepSeek 文档明确历史轮 CoT 不参与上下文），避免推理内容
 * 被当上下文重复灌入。其余行为与父类保持一致，防止格式漂移。
 */
import { OpenAIChatFormatter } from '@agentscope-ai/agentscope/formatter'
import { getContentBlocks } from '@agentscope-ai/agentscope/message'
import type { Msg } from '@agentscope-ai/agentscope/message'

type FormattedMsg = {
  role: string
  name: string
  content: Record<string, unknown>[] | null
  reasoning_content?: string
  tool_calls?: {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}

export class ReasoningChatFormatter extends OpenAIChatFormatter {
  async format({ msgs }: { msgs: Array<Msg> }): Promise<Record<string, unknown>[]> {
    const formattedMsgs: Array<Record<string, unknown>> = []
    let index = 0

    while (index < msgs.length) {
      const msg = msgs[index]
      const formattedMsg: FormattedMsg = {
        role: msg.role,
        name: msg.name,
        content: null,
      }
      const content: Record<string, unknown>[] = []
      // 工具结果消息必须紧跟在发起 tool_call 的 assistant 消息之后，先缓存再统一追加。
      const cachedMsgs: Record<string, unknown>[] = []
      let reasoning = ''

      for (const block of getContentBlocks(msg)) {
        switch (block.type) {
          case 'text':
            content.push(this._formatTextBlock(block))
            break
          case 'thinking':
            // 唯一与父类的差异：保留思考内容，等消息级汇总后写进 reasoning_content。
            reasoning += block.thinking
            break
          case 'tool_call':
            if (!formattedMsg.tool_calls) formattedMsg.tool_calls = []
            formattedMsg.tool_calls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: block.input },
            })
            break
          case 'tool_result': {
            const formattedToolResult = this.convertToolOutputToString(block.output, false)
            cachedMsgs.push({
              role: 'tool',
              tool_call_id: block.id,
              name: block.name,
              content: formattedToolResult.text,
            })
            break
          }
          case 'data':
            content.push(...(await this._formatMultimodalBlock({ block, role: msg.role })))
            break
        }
      }

      if (content.length > 0) formattedMsg.content = content
      // 思考模式的工具调用链要求回传推理内容；普通问答轮不回传历史 CoT。
      if (msg.role === 'assistant' && formattedMsg.tool_calls && reasoning.trim()) {
        formattedMsg.reasoning_content = reasoning
      }
      if (formattedMsg.content || formattedMsg.tool_calls) {
        formattedMsgs.push(formattedMsg)
      }
      if (cachedMsgs.length > 0) formattedMsgs.push(...cachedMsgs)

      index++
    }

    return formattedMsgs
  }
}
