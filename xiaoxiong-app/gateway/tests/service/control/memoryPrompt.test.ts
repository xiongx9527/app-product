import { describe, it, expect } from 'vitest'
import { detectPreference, isAffirmative, isNegative, mergeMemoryValue } from '../../../src/service/control/memoryPrompt'

describe('mergeMemoryValue（相似记忆合并更新）', () => {
  it.each([
    [undefined, '喜欢吃苹果', '喜欢吃苹果'],
    ['喜欢吃苹果', '喜欢吃苹果', '喜欢吃苹果'],       // 完全相同不重复
    ['喜欢吃苹果', '爱吃香蕉', '喜欢吃苹果、爱吃香蕉'], // 合并
    ['喜欢吃苹果、爱吃香蕉', '爱吃香蕉', '喜欢吃苹果、爱吃香蕉'], // 已含新条目不重复加
    ['喜欢吃苹果', '喜欢吃苹果、香蕉', '喜欢吃苹果、香蕉'], // 新含旧取更全
    ['', '喜欢打篮球', '喜欢打篮球'],
  ])('合并：%s + %s → %s', (old, inc, expected) => {
    expect(mergeMemoryValue(old, inc)).toBe(expected)
  })
})

describe('detectPreference（偏好句检测）', () => {
  it.each([
    ['我喜欢吃苹果', '喜欢吃苹果'],
    ['我爱吃辣', '爱吃辣'],
    ['我习惯早起', '习惯早起'],
    ['我的爱好是读书', '爱好是读书'],
    ['我最爱看电影了', '最爱看电影'],
    ['我倾向于坐高铁', '倾向于坐高铁'],
    ['我偏爱喝咖啡。', '偏爱喝咖啡'],
  ])('提取偏好：%s → %s', (text, expected) => {
    expect(detectPreference(text)).toBe(expected)
  })

  it.each([
    '今天天气怎么样',
    '播放周杰伦的稻香',
    '我喜欢的那首歌叫什么',
    '他喜欢吃苹果',
    '',
  ])('非偏好句返回 null：%s', (text) => {
    expect(detectPreference(text)).toBeNull()
  })
})

describe('isAffirmative（肯定意图）', () => {
  it.each([
    '好', '好的', '行', '可以', '要', '嗯', '对', '是的', '当然',
    '没问题', 'ok', 'OK', '记吧', '记一下', '那就记下来', '你记吧',
    '嗯，记一下吧', '好的，记吧', '嗯，记一下', '记下吧',
  ])('肯定：%s', (text) => {
    expect(isAffirmative(text)).toBe(true)
  })

  it.each([
    // 回答了 LLM 的反问 + 明确要记：混合句也算肯定（真机「我喜欢乒乓球」场景）
    '打球，要记下来', '我喜欢打，记一下', '打乒乓球的，帮我记', '随便吧，记住',
    '两种都行，那就记下来', '嗯，要记下来', '好啊记下来',
  ])('混合句肯定：%s', (text) => {
    expect(isAffirmative(text)).toBe(true)
  })

  it.each([
    '不用', '不要', '算了', '不', '别', '取消', 'no', '再说说',
    '今天天气怎么样', '播放音乐', '',
    // 含记短语但明确否定，不能误记
    '不用记下来', '别记', '不要记', '不用帮我记',
  ])('非肯定：%s', (text) => {
    expect(isAffirmative(text)).toBe(false)
  })
})

describe('isNegative（否定意图）', () => {
  it.each(['不用', '不要', '算了', '不记', '取消', 'no'])('否定：%s', (text) => {
    expect(isNegative(text)).toBe(true)
  })
  it.each(['好', '要', '可以', ''])('非否定：%s', (text) => {
    expect(isNegative(text)).toBe(false)
  })
})
