import { describe, it, expect } from 'vitest'
import { detectPoemCommand } from '../../../../src/service/skills/edu_skill/detect'

describe('detectPoemCommand', () => {
  it('背诵/朗诵/朗读/念/读 + 作品名 → 提取作品名', () => {
    expect(detectPoemCommand('背诵滕王阁序')?.title).toBe('滕王阁序')
    expect(detectPoemCommand('朗诵岳阳楼记')?.title).toBe('岳阳楼记')
    expect(detectPoemCommand('朗读滕王阁序')?.title).toBe('滕王阁序') // 用户高频用词，曾漏配触发词掉进 LLM
    expect(detectPoemCommand('念一下静夜思')?.title).toBe('静夜思')
    expect(detectPoemCommand('读一下将进酒')?.title).toBe('将进酒')
    expect(detectPoemCommand('背一下王勃的滕王阁序')?.title).toBe('王勃的滕王阁序')
  })

  it('作品名带书名号《》 → 剥掉再查（带符号查询命中率下降）', () => {
    expect(detectPoemCommand('朗读《滕王阁序》')?.title).toBe('滕王阁序')
    expect(detectPoemCommand('背诵《滕王阁序》。')?.title).toBe('滕王阁序')
    expect(detectPoemCommand('朗诵《岳阳楼记》')?.title).toBe('岳阳楼记')
  })

  it('纯「背诵」无作品名 → title=null（提示用户说背哪首）', () => {
    expect(detectPoemCommand('背诵')).toEqual({ title: null })
    expect(detectPoemCommand('朗诵一下')).toEqual({ title: null })
  })

  it('无朗读动词的泛问不命中（交 LLM）', () => {
    expect(detectPoemCommand('滕王阁序是什么意思')).toBeNull()
    expect(detectPoemCommand('播放周杰伦的歌')).toBeNull()
    expect(detectPoemCommand('百科刘备')).toBeNull()
  })

  it('点歌句式含「念出」不误命中诗词', () => {
    expect(detectPoemCommand('念出3首周杰伦的歌')).toBeNull()
    expect(detectPoemCommand('列出并念出周杰伦的歌')).toBeNull()
  })

  it('ASR 连读多句：只在第一个标点处截断，不把后续指令当作品名', () => {
    expect(detectPoemCommand('背诵回乡偶书，给我回答没有书的好价')?.title).toBe('回乡偶书')
    expect(detectPoemCommand('朗诵静夜思。顺便查下天气')?.title).toBe('静夜思')
  })

  it('ASR 把咳嗽/犹豫字识别进作品名：清洗后仍能提取', () => {
    expect(detectPoemCommand('背诵嗯嗯回乡偶书')?.title).toBe('回乡偶书')
    expect(detectPoemCommand('咳背诵静夜思')?.title).toBe('静夜思')
    expect(detectPoemCommand('背诵滕嗯王阁序')?.title).toBe('滕王阁序')
    expect(detectPoemCommand('嗯那个背诵将进酒')?.title).toBe('将进酒')
  })
})
