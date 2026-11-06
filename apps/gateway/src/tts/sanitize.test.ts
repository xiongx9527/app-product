import { describe, it, expect } from 'vitest'
import { sanitizeForSpeech } from './sanitize'

describe('TTS 文本清洗', () => {
  it('剥掉 markdown 强调符、特殊符号、emoji', () => {
    expect(sanitizeForSpeech('**&……%¥#@')).toBe('')
    expect(sanitizeForSpeech('这是**重点**内容 #标签')).toBe('这是重点内容 标签')
    expect(sanitizeForSpeech('你好 🌟 世界')).toBe('你好 世界')
  })

  it('保留可朗读的中英文、数字与常用标点', () => {
    expect(sanitizeForSpeech('你好，我是小熊！今天 25 度。OK?')).toBe(
      '你好，我是小熊！今天 25 度。OK?'
    )
  })

  it('连续空白收敛成一个空格', () => {
    expect(sanitizeForSpeech('你好\n\n   世界')).toBe('你好 世界')
  })
})
