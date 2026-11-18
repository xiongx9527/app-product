import { describe, it, expect } from 'vitest'
import { AsrCorrector } from './asrCorrector'

describe('AsrCorrector（ASR 同音错字确定性纠错，零误纠）', () => {
  const c = new AsrCorrector()

  it('同音错字：周杰轮→周杰伦、静夜丝→静夜思', () => {
    expect(c.correct('播放周杰轮的一路向北')).toBe('播放周杰伦的一路向北')
    expect(c.correct('静夜丝')).toBe('静夜思')
  })

  it('精确错字映射：滕王格世/滕王格式→滕王阁序', () => {
    expect(c.correct('朗诵滕王格世')).toBe('朗诵滕王阁序')
    expect(c.correct('朗诵滕王格式')).toBe('朗诵滕王阁序')
    expect(c.correct('岳洋楼记')).toBe('岳阳楼记')
  })

  it('拼音相近但不是同音的，绝不误纠（上次踩坑：天气→天津）', () => {
    expect(c.correct('今天天气怎么样')).toBe('今天天气怎么样')
    expect(c.correct('北京天气')).toBe('北京天气')
    expect(c.correct('天气很好')).toBe('天气很好')
    expect(c.correct('一路向北')).toBe('一路向北')
    expect(c.correct('乱七八糟的乱说')).toBe('乱七八糟的乱说')
    expect(c.correct('我想听歌')).toBe('我想听歌')
  })

  it('多个同音候选时不纠（无法判断用哪个）', () => {
    // "shi li" 对应多个正确词，命中多个就不纠
    const c2 = new AsrCorrector([
      { wrong: '实力', pinyin: 'shi li', correct: '事例' },
      { wrong: '势力', pinyin: 'shi li', correct: '势力' },
    ])
    expect(c2.correct('工作流事例')).toBe('工作流事例')
  })

  it('load 导入的词表也能被同音纠正', () => {
    const c3 = new AsrCorrector([])
    c3.load([{ wrong: '小熊住手', pinyin: 'xiao xiong zhu shou', correct: '小熊助手' }])
    expect(c3.correct('小熊住手')).toBe('小熊助手')
  })

  it('空串 / 纯符号原样返回', () => {
    expect(c.correct('')).toBe('')
    expect(c.correct('123')).toBe('123')
  })
})
