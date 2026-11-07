import { describe, it, expect } from 'vitest'
import { ChannelSplitter } from './channelSplitter'

function run(chunks: string[]): { delta: string; thinking: string } {
  const delta: string[] = []
  const thinking: string[] = []
  const sp = new ChannelSplitter(
    (s) => delta.push(s),
    (s) => thinking.push(s)
  )
  for (const c of chunks) sp.push(c)
  sp.end()
  return { delta: delta.join(''), thinking: thinking.join('') }
}

describe('ChannelSplitter', () => {
  it('无标记时整体作为正式回答下发', () => {
    const r = run(['你好，今天天气不错。'])
    expect(r.delta).toBe('你好，今天天气不错。')
    expect(r.thinking).toBe('')
  })

  it('analysis 走思考、final 走正式回答', () => {
    const raw =
      '<|start|>assistant<|channel|>analysis<|message|>The user wants music.<|start|>assistant<|channel|>final<|message|>好的，已为您播放轻音乐。'
    const r = run([raw])
    expect(r.thinking).toBe('The user wants music.')
    expect(r.delta).toBe('好的，已为您播放轻音乐。')
  })

  it('标记被拆到两个 chunk 仍能正确拆分', () => {
    const r = run([
      '<|start|>assistant<|channel|>ana',
      'lysis<|message|>先想想<|start|>assistant<|channel|>final<|message|>答案',
    ])
    expect(r.thinking).toBe('先想想')
    expect(r.delta).toBe('答案')
  })

  it('残留控制符被剥离，绝不下发', () => {
    const r = run(['<|start|>assistant<|channel|>final<|message|>A<|end|>B<|weird|>C'])
    expect(r.delta).toBe('ABC')
    expect(r.delta).not.toContain('<|')
  })

  it('未标记的前导语作为正式回答', () => {
    const r = run(['导语<|start|>assistant<|channel|>analysis<|message|>思考'])
    expect(r.delta).toBe('导语')
    expect(r.thinking).toBe('思考')
  })

  it('末尾残缺的标记前缀不下发（等 end 兜底）', () => {
    // 最后一个 chunk 以 '<' 结尾，疑似被截断的标记，应保留到 end 再处理
    const r = run(['正式<|start|>assistant<|channel|>final<|message|>完<|'])
    expect(r.delta).toBe('正式完')
  })
})
