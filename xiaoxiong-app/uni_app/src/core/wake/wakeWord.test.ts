import { describe, expect, it } from 'vitest'
import { matchWakeWord, normalizeTranscript } from './wakeWord'

const WORDS = ['小熊小熊']

describe('wake word matching', () => {
  it('去掉空格与标点后再匹配', () => {
    expect(normalizeTranscript('小熊，小熊！')).toBe('小熊小熊')
    expect(matchWakeWord('小熊，小熊！', WORDS)).toBe('小熊小熊')
  })

  it('识别结果里带前后缀也能命中', () => {
    expect(matchWakeWord('嗯那个小熊小熊你在吗', WORDS)).toBe('小熊小熊')
  })

  it('两个“小熊”之间有停顿时也能命中', () => {
    expect(matchWakeWord('小熊 小熊', WORDS)).toBe('小熊小熊')
  })

  it('只说一半不会误触发', () => {
    expect(matchWakeWord('小熊今天乖吗', WORDS)).toBeNull()
  })

  it('普通对话不会误触发', () => {
    expect(matchWakeWord('今天天气怎么样', WORDS)).toBeNull()
  })

  it('空识别结果不匹配', () => {
    expect(matchWakeWord('   ', WORDS)).toBeNull()
    expect(matchWakeWord('', WORDS)).toBeNull()
  })

  it('唤醒词为空时不会匹配一切', () => {
    expect(matchWakeWord('随便说点什么', ['', '  '])).toBeNull()
  })
})
