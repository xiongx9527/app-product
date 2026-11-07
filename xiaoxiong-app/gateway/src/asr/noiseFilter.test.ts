import { describe, it, expect } from 'vitest'
import { isNoise, resemblesSpoken, pcmRms } from './noiseFilter'

describe('ASR 杂音过滤', () => {
  it('纯符号、空白、幻觉短词判为噪声', () => {
    expect(isNoise('**&……%¥#@')).toBe(true)
    expect(isNoise('   ')).toBe(true)
    expect(isNoise('Yeah.')).toBe(true)
    expect(isNoise('Yes.')).toBe(true)
    expect(isNoise('嗯。')).toBe(true)
    expect(isNoise('谢谢观看')).toBe(true)
  })

  it('正常短问句放行，不误杀实义单字', () => {
    expect(isNoise('今天天气怎么样')).toBe(false)
    expect(isNoise('滚。')).toBe(false)
    expect(isNoise('好')).toBe(false)
  })

  it('与刚播报的内容高度雷同判为回声', () => {
    const spoken = ['你好，我是小熊语音助手，有什么可以帮你？']
    expect(resemblesSpoken('你好，我是小熊语音助手，有什么可以帮你？', spoken)).toBe(true)
    expect(resemblesSpoken('我是小熊语音助手', spoken)).toBe(true)
    expect(resemblesSpoken('那明天天气呢？', spoken)).toBe(false)
  })

  it('pcmRms 反映幅度，静音帧为 0', () => {
    expect(pcmRms(new Uint8Array(320))).toBe(0)
    const loud = new Int16Array(160)
    loud.fill(8000)
    expect(pcmRms(new Uint8Array(loud.buffer))).toBeCloseTo(8000 / 32768, 3)
  })
})
