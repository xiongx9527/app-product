import { describe, it, expect } from 'vitest'
import { sentenceCut } from '../../src/service/voiceSessionService'

/** 断句：遇任意合法标点即切；绝不拦腰截断字数；英文句号做边界判定。 */
describe('sentenceCut：遇标点即切', () => {
  it('句末标点立即成句（中英文）', () => {
    expect(sentenceCut('今天天气不错。明天再说')).toBe('今天天气不错。'.length)
    expect(sentenceCut('Really? Yes')).toBe('Really?'.length)
    expect(sentenceCut('好！next')).toBe('好！'.length)
    expect(sentenceCut('什么？不知道')).toBe('什么？'.length)
    expect(sentenceCut('第一；第二')).toBe('第一；'.length)
    expect(sentenceCut('a; b')).toBe('a;'.length)
  })

  it('逗号、顿号立即成句（不再要求逗号前字数）', () => {
    expect(sentenceCut('你好，世界')).toBe('你好，'.length)
    expect(sentenceCut('好，')).toBe(2)
    expect(sentenceCut('苹果、香蕉')).toBe('苹果、'.length)
    expect(sentenceCut('hello, world')).toBe('hello,'.length)
  })

  it('冒号立即成句（首字提速：长首句拆短）', () => {
    expect(sentenceCut('各年级班级数量为：一年级4个，')).toBe('各年级班级数量为：'.length)
    expect(sentenceCut('结果如下: 3个班级')).toBe('结果如下:'.length)
  })

  it('英文句号排除小数 / 域名 / 缩写 / 省略号', () => {
    expect(sentenceCut('PI is 3.14 ok')).toBe(-1)
    expect(sentenceCut('Visit example.com now')).toBe(-1)
    expect(sentenceCut('Mr. Smith is here')).toBe(-1)
    expect(sentenceCut('etc. And so on')).toBe(-1)
    expect(sentenceCut('Wait... ok')).toBe(-1)
    // 真句末英文句号照切
    expect(sentenceCut('I am fine. Next')).toBe('I am fine.'.length)
  })

  it('流式分批：数字后的小数点在末尾时不切，等小数位到齐（2026-11-27 真机）', () => {
    // LLM 先吐「平均80.」、下一批才来「27」——小数点后没数字前不能当句末切，
    // 否则 TTS 念成「平均八十」「二十七」，80.27 的小数点丢失。
    expect(sentenceCut('平均80.')).toBe(-1)
    expect(sentenceCut('平均80.27，')).toBe('平均80.27，'.length)
    // 字母句末仍照切（英文句子 "Result." 不是小数）
    expect(sentenceCut('The score is A.')).toBe('The score is A.'.length)
  })

  it('无标点不硬切，继续攒到标点收尾', () => {
    const long = '这是一段很长很长的文字没有任何标点符号'.repeat(10)
    expect(sentenceCut(long)).toBe(-1)
    // 攒很久后终于遇到逗号：在逗号处切，带标点收尾
    expect(sentenceCut(long + '，后面')).toBe(long.length + 1)
  })
})
