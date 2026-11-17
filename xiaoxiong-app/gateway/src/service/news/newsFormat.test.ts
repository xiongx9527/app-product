import { describe, it, expect } from 'vitest'
import { formatNews, type NewsResult } from './types'

const result = (over: Partial<NewsResult> = {}): NewsResult => ({
  ok: true,
  headlines: [
    { title: '科学家研发新型芯片取得突破', source: '科技日报' },
    { title: '全国多地迎来降雨天气' },
  ],
  ...over,
})

describe('formatNews', () => {
  it('泛播：中文引导 + 标题，来源在时追加、不在时不编造', () => {
    expect(formatNews('zh-CN', result(), null)).toBe(
      '为你播报今天的 2 条新闻：科学家研发新型芯片取得突破，科技日报。全国多地迎来降雨天气。'
    )
  })

  it('带话题：中文引导说明话题与条数，条数按实际列表', () => {
    expect(formatNews('zh-CN', result(), '科技')).toBe(
      '查到 2 条与「科技」相关的新闻：科学家研发新型芯片取得突破，科技日报。全国多地迎来降雨天气。'
    )
  })

  it('英文会话：引导与「没有结果」走英文，标题保留原文', () => {
    expect(formatNews('en-US', result(), null)).toBe(
      "Here are today's 2 news headlines: 科学家研发新型芯片取得突破，科技日报。全国多地迎来降雨天气。"
    )
    expect(formatNews('en-US', result(), '科技')).toBe(
      'Found 2 news items about "科技": 科学家研发新型芯片取得突破，科技日报。全国多地迎来降雨天气。'
    )
  })

  it('超过 limit 只播前 limit 条，引导条数也按实际播报数', () => {
    const many = result({
      headlines: [
        { title: '标题一足够长了吧' },
        { title: '标题二足够长了吧' },
        { title: '标题三足够长了吧' },
      ],
    })
    const text = formatNews('zh-CN', many, null, 2)
    expect(text.startsWith('为你播报今天的 2 条新闻：')).toBe(true)
    expect(text).not.toContain('标题三')
  })

  it('抓到 0 条：分泛播与话题两种「没查到」，不编造', () => {
    expect(formatNews('zh-CN', result({ headlines: [] }), null)).toBe('暂时没查到新闻。')
    expect(formatNews('zh-CN', result({ headlines: [] }), '汽车')).toBe(
      '暂时没查到与「汽车」相关的新闻。'
    )
    expect(formatNews('en-US', result({ headlines: [] }), null)).toBe(
      'No news found right now.'
    )
  })

  it('抓取失败：诚实兜底，中英文各自本地化', () => {
    expect(formatNews('zh-CN', { ok: false, headlines: [] }, null)).toBe(
      '现在查不了新闻，稍后再试。'
    )
    expect(formatNews('en-US', { ok: false, headlines: [] }, '科技')).toBe(
      "Can't fetch news right now. Please try again later."
    )
  })
})
