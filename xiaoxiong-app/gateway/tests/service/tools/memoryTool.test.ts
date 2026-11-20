import { describe, it, expect, vi } from 'vitest'
import { createRememberTool, type MemoryStore } from '../../../src/service/tools/memoryTool'

function makeStore(): MemoryStore & { saved: Array<{ key: string; value: string }> } {
  const saved: Array<{ key: string; value: string }> = []
  return {
    saved,
    save: vi.fn(async (key, value) => { saved.push({ key, value }) }),
    list: vi.fn(async () => []),
    forget: vi.fn(async () => 0),
  }
}

describe('remember 工具：分类走确定性词表，不信 LLM 给的 key', () => {
  it('LLM 给垃圾 key「下来」时，按 value 确定性分类为「运动」', async () => {
    const store = makeStore()
    const tool = createRememberTool('zh-CN', store)
    await tool.call({ key: '下来', value: '我喜欢打乒乓球' })
    expect(store.saved).toHaveLength(1)
    expect(store.saved[0].key).toBe('运动')
    expect(store.saved[0].value).toBe('我喜欢打乒乓球')
  })

  it('苹果 → 水果，年龄 → 个人信息', async () => {
    const store = makeStore()
    const tool = createRememberTool('zh-CN', store)
    await tool.call({ key: '随便', value: '爱吃苹果' })
    await tool.call({ key: 'x', value: '我今年三十岁' })
    expect(store.saved.map((s) => s.key)).toEqual(['水果', '个人信息'])
  })

  it('太短的内容仍被拒收', async () => {
    const store = makeStore()
    const tool = createRememberTool('zh-CN', store)
    const r = await tool.call({ key: '偏好', value: '哦' })
    expect(store.saved).toHaveLength(0)
    expect(r).toContain('不记')
  })
})
