import { describe, it, expect } from 'vitest'
import { sanitizeForSpeech } from '../../src/tts/sanitize'

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

  it('数字小数点读成「点」（2026-11-27 真机：平均分 80.27 丢小数点）', () => {
    expect(sanitizeForSpeech('平均分80.27，最高99')).toBe('平均分80点27，最高99')
    expect(sanitizeForSpeech('价格 3.14 元')).toBe('价格 3点14 元')
  })

  it('通用技术路径不念（2026-11-27，不针对特定字段/工具）', () => {
    // 真机复现：LLM 把工具结果里的图片路径复述进回复
    expect(sanitizeForSpeech('一年级学生人数如下。图表：/api/chart/image/2ff1cf2a874940f2846cf16998547169'))
      .toBe('一年级学生人数如下。图表：')
    // 其它接口路径同样按形态剥掉，不写死字段名
    expect(sanitizeForSpeech('详见 /voice/v1/audio/voices 文档')).toBe('详见 文档')
    // 纯数字/日期不是路径，数字照常保留（`/` 本就不在可朗读白名单，日期连读是既有行为，
    // 关键是不能被当成整段路径吞掉——那样数字会全丢）
    expect(sanitizeForSpeech('今天是 2026/11/27，比例 3/4')).toBe('今天是 20261127，比例 34')
  })
})
