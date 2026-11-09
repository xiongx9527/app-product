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

const A = '<|start|>assistant<|channel|>analysis<|message|>'
const F = '<|start|>assistant<|channel|>final<|message|>'
const END = '<|end|>'

describe('ChannelSplitter', () => {
  it('无标记时整体作为正式回答下发', () => {
    const r = run(['你好，今天天气不错。'])
    expect(r.delta).toBe('你好，今天天气不错。')
    expect(r.thinking).toBe('')
  })

  it('analysis 走思考、final 走正式回答', () => {
    const r = run([`${A}The user wants music.${END}${F}好的，已为您播放轻音乐。`])
    expect(r.thinking).toBe('The user wants music.')
    expect(r.delta).toBe('好的，已为您播放轻音乐。')
  })

  it('截图复现：analysis 里的英文推理+原始 token 不进回答，只显示 final', () => {
    const raw =
      `${A}The user wants music, we tried playing generic. Probably just respond confirming.${END}` +
      `${F}好的，已为您播放轻音乐。如果需要切换曲目或停止播放，请随时告诉我。<|return|>`
    // 模拟逐字流式下发
    const chunks = raw.match(/.{1,7}/gs) ?? []
    const r = run(chunks)
    expect(r.delta).toBe('好的，已为您播放轻音乐。如果需要切换曲目或停止播放，请随时告诉我。')
    expect(r.delta).not.toContain('<|')
    expect(r.delta).not.toContain('analysis')
    expect(r.thinking).toContain('The user wants music')
  })

  it('header 被拆到多个 chunk 仍能正确拆分', () => {
    const r = run([
      '<|start|>assistant<|channel|>ana',
      'lysis<|message|>先想想<|end|><|start|>assistant<|channel|>final<|message|>答案',
    ])
    expect(r.thinking).toBe('先想想')
    expect(r.delta).toBe('答案')
  })

  it('工具调用 header（to= 收件人 + commentary）不当作正文下发', () => {
    const raw =
      '<|start|>assistant to=functions.play_music<|channel|>commentary to=functions.play_music <|constrain|>json<|message|>{"genre":"轻音乐"}' +
      `${END}${F}正在为你播放。`
    const r = run([raw])
    expect(r.delta).toBe('正在为你播放。')
    expect(r.delta).not.toContain('play_music')
    expect(r.thinking).toContain('"genre"')
  })

  it('残留控制符被剥离，绝不下发', () => {
    const r = run([`${F}A<|end|>B<|weird|>C<|return|>`])
    expect(r.delta).toBe('ABC')
    expect(r.delta).not.toContain('<|')
  })

  it('未标记的前导语作为正式回答', () => {
    const r = run([`导语${A}思考`])
    expect(r.delta).toBe('导语')
    expect(r.thinking).toBe('思考')
  })

  it('末尾残缺的 header 前缀不下发（等 end 兜底）', () => {
    const r = run([`${F}完<|`])
    expect(r.delta).toBe('完')
  })

  it('没有 analysis、只有 final 时 final 内容完整可见', () => {
    const r = run([`${F}抱歉，我没听清，能再说一遍吗？<|return|>`])
    expect(r.delta).toBe('抱歉，我没听清，能再说一遍吗？')
  })

  it('截图复现：裸词 thought + 变形 channel 开启符被剥离，不进正文也不进思考', () => {
    const r = run(['thought\n<channel|>'])
    expect(r.delta).toBe('')
    expect(r.thinking).toBe('')
    expect(r.delta).not.toContain('thought')
    expect(r.delta).not.toContain('channel')
  })

  it('泄漏标记后跟正常正文：只保留正文', () => {
    const r = run(['thought\n<channel|>\n好的，已为您播放。'])
    expect(r.delta).toBe('好的，已为您播放。')
    expect(r.delta).not.toContain('thought')
    expect(r.delta).not.toContain('channel')
  })

  it('末尾截断的 <channel| 残片（无闭合 >）也剥离', () => {
    const r = run([`${F}完<channel|`])
    expect(r.delta).toBe('完')
  })
})
