import { describe, it, expect } from 'vitest'
import { detectAuspiciousQuery } from './auspiciousControl'

describe('detectAuspiciousQuery（择吉日/黄历直连识别）', () => {
  it('带事项的吉日请求：映射到黄历宜词', () => {
    expect(detectAuspiciousQuery('推荐个搬家吉日')).toEqual({ activity: '搬家', yiWords: ['移徙', '入宅'] })
    expect(detectAuspiciousQuery('帮我选个结婚的好日子')).toEqual({ activity: '嫁娶', yiWords: ['嫁娶'] })
    expect(detectAuspiciousQuery('什么时候开业比较好，看看黄历')).toEqual({ activity: '开业', yiWords: ['开市', '交易', '立券'] })
  })

  it('泛吉日（没说事项）：命中触发词但无事项映射', () => {
    expect(detectAuspiciousQuery('推荐个好日子')).toEqual({ activity: null, yiWords: [] })
    expect(detectAuspiciousQuery('最近有黄道吉日吗')).toEqual({ activity: null, yiWords: [] })
  })

  it('问日期的句子不命中（归时间直连）', () => {
    expect(detectAuspiciousQuery('今天是什么日子')).toBeNull()
    expect(detectAuspiciousQuery('今天星期几')).toBeNull()
    expect(detectAuspiciousQuery('几月几号了')).toBeNull()
  })

  it('普通对话/商品查询不命中', () => {
    expect(detectAuspiciousQuery('推荐一款空调')).toBeNull()
    expect(detectAuspiciousQuery('你好，随便聊聊')).toBeNull()
  })
})
