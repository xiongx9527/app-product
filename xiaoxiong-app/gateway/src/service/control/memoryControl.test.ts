import { describe, it, expect } from 'vitest'
import { detectMemoryCommand } from './memoryControl'

describe('detectMemoryCommand：忘了XX / 清空记忆', () => {
  it('忘了 + 话题 → forget', () => {
    expect(detectMemoryCommand('忘了我的作息')).toEqual({ action: 'forget', topic: '我的作息' })
  })

  it('忘记 + 话题 → forget', () => {
    expect(detectMemoryCommand('忘记我喜欢吃辣')).toEqual({ action: 'forget', topic: '我喜欢吃辣' })
  })

  it('别记 + 话题 → forget', () => {
    expect(detectMemoryCommand('别记我昨天说的')).toEqual({ action: 'forget', topic: '我昨天说的' })
  })

  it('清空记忆 / 清除记忆 → clear', () => {
    expect(detectMemoryCommand('清空记忆')).toEqual({ action: 'clear' })
    expect(detectMemoryCommand('清除我的记忆')).toEqual({ action: 'clear' })
  })

  it('只说「忘了」没给话题 → 当作 clear，避免空 topic 全盘误删', () => {
    expect(detectMemoryCommand('忘了')).toEqual({ action: 'clear' })
  })

  it('「我忘了带钥匙」这种陈述不命中（不是删除指令）', () => {
    expect(detectMemoryCommand('我忘了带钥匙')).toBeNull()
  })

  it('「不记得了」不命中', () => {
    expect(detectMemoryCommand('这个我不记得了')).toBeNull()
  })

  it('普通闲聊不命中', () => {
    expect(detectMemoryCommand('今天天气怎么样')).toBeNull()
  })
})
