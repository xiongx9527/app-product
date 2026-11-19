import { describe, it, expect } from 'vitest'
import { AsrCorrector } from '../../../src/service/asr/asrCorrector'

// 所有纠错词都来自数据（本地学 / 9529 同步），没有内置默认词表。
const seed: Array<{ wrong: string; pinyin: string; correct: string }> = [
  { wrong: '周杰轮', pinyin: 'zhou jie lun', correct: '周杰伦' },
  { wrong: '静夜丝', pinyin: 'jing ye si', correct: '静夜思' },
  { wrong: '滕王格世', pinyin: 'teng wang ge shi', correct: '滕王阁序' },
  { wrong: '若神父', pinyin: 'ruo shen fu', correct: '洛神赋' },
]

describe('AsrCorrector（ASR 同音错字确定性纠错，零误纠）', () => {
  const c = new AsrCorrector(seed)

  it('同音错字：周杰轮→周杰伦、静夜丝→静夜思', () => {
    expect(c.correct('播放周杰轮的一路向北')).toBe('播放周杰伦的一路向北')
    expect(c.correct('静夜丝')).toBe('静夜思')
  })

  it('精确错字映射：滕王格世→滕王阁序', () => {
    expect(c.correct('朗诵滕王格世')).toBe('朗诵滕王阁序')
  })

  it('没有内置默认词表：不在数据里的词（李存勖等）绝不纠', () => {
    const empty = new AsrCorrector()
    expect(empty.correct('李存旭的百科')).toBe('李存旭的百科')
    expect(empty.correct('朗诵滕王格式')).toBe('朗诵滕王格式')
    // 即使 c 加载过词表，也不含李存勖
    expect(c.correct('李存旭的百科')).toBe('李存旭的百科')
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

  it('load 导入的词表能被同音纠正，且只认传入的词', () => {
    const c3 = new AsrCorrector([])
    c3.load([{ wrong: '小熊住手', pinyin: 'xiao xiong zhu shou', correct: '小熊助手' }])
    expect(c3.correct('小熊住手')).toBe('小熊助手')
    expect(c3.correct('周杰轮')).toBe('周杰轮') // 没传入就不纠
  })

  it('空串 / 纯符号原样返回', () => {
    expect(c.correct('')).toBe('')
    expect(c.correct('123')).toBe('123')
  })
})
