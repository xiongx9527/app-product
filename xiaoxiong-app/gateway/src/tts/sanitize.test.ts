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

  it('HTML 标签不念，标签里的文字照常念', () => {
    expect(sanitizeForSpeech('<div>今天<strong>晴</strong></div><br/>26 度')).toBe('今天晴 26 度')
    expect(sanitizeForSpeech('<script>alert(1)</script>你好')).toBe('你好')
  })

  it('流式截断的半个标签不念', () => {
    expect(sanitizeForSpeech('你好<stro')).toBe('你好')
    expect(sanitizeForSpeech('你好</div')).toBe('你好')
  })

  it('HTML 实体不念成 nbsp', () => {
    expect(sanitizeForSpeech('A&nbsp;和&nbsp;B')).toBe('A 和 B')
  })

  it('Markdown 链接只念文字，不念 URL', () => {
    expect(sanitizeForSpeech('详见[说明](https://a.com/x?y=1)')).toBe('详见说明')
    expect(sanitizeForSpeech('打开 https://a.com/x 看看')).toBe('打开 看看')
  })

  it('标题、列表、代码围栏符号不念', () => {
    expect(sanitizeForSpeech('### 今日天气\n- 晴\n- 26 度')).toBe('今日天气 晴 26 度')
    expect(sanitizeForSpeech('```\n今天天气不错\n```')).toBe('今天天气不错')
  })
})
