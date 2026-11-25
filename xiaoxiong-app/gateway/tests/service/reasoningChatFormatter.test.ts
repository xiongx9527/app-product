import { describe, it, expect } from 'vitest'
import { createMsg } from '@agentscope-ai/agentscope/message'
import { ReasoningChatFormatter } from '../../src/service/reasoningChatFormatter'

const fmt = new ReasoningChatFormatter()

/** 构造一条带思考块 + 工具调用的 assistant 消息（模拟模型「先思考、再调工具」的输出）。 */
function assistantWithToolCall() {
  return createMsg({
    name: 'Xiong',
    role: 'assistant',
    content: [
      { type: 'thinking', id: 't1', thinking: '先查位置，再查周边。', created_at: new Date().toISOString() },
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'get_current_location',
        input: '{}',
        state: 'pending',
        created_at: new Date().toISOString(),
      },
    ],
  })
}

describe('思考模式消息格式化：工具调用链必须回传 reasoning_content', () => {
  it('assistant 带 thinking + tool_calls → 输出 reasoning_content（否则上游 400）', async () => {
    const out = await fmt.format({ msgs: [assistantWithToolCall()] })
    const assistant = out[0] as Record<string, unknown>
    expect(assistant.role).toBe('assistant')
    expect(assistant.reasoning_content).toBe('先查位置，再查周边。')
    expect(Array.isArray(assistant.tool_calls)).toBe(true)
  })

  it('普通问答轮（thinking + text，无工具调用）不回传历史推理链', async () => {
    const msg = createMsg({
      name: 'Xiong',
      role: 'assistant',
      content: [
        { type: 'thinking', id: 't1', thinking: '想一想。', created_at: new Date().toISOString() },
        { type: 'text', id: 'x1', text: '你好。', created_at: new Date().toISOString() },
      ],
    })
    const out = await fmt.format({ msgs: [msg] })
    expect((out[0] as Record<string, unknown>).reasoning_content).toBeUndefined()
    expect((out[0] as Record<string, unknown>).content).toBeTruthy()
  })

  it('用户消息不产生 reasoning_content', async () => {
    const msg = createMsg({ name: 'user', role: 'user', content: [{ type: 'text', id: 'x1', text: '查询周边', created_at: new Date().toISOString() }] })
    const out = await fmt.format({ msgs: [msg] })
    expect((out[0] as Record<string, unknown>).reasoning_content).toBeUndefined()
  })

  it('工具结果仍紧跟在发起调用的 assistant 消息之后', async () => {
    const toolResult = createMsg({
      name: 'get_current_location',
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          id: 'call_1',
          name: 'get_current_location',
          output: [{ type: 'text', id: 'r1', text: '纬度 28.6，经度 116.0', created_at: new Date().toISOString() }],
          state: 'success',
          created_at: new Date().toISOString(),
        },
      ],
    })
    const out = await fmt.format({ msgs: [assistantWithToolCall(), toolResult] })
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool'])
    expect((out[1] as Record<string, unknown>).tool_call_id).toBe('call_1')
  })
})
