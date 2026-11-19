import { describe, it, expect } from 'vitest'
import { detectPreference, isAffirmative, isNegative, classifyPreference, mergeMemoryValue } from './memoryPrompt'

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

describe('classifyPreference（内置分类兜底）', () => {
  it.each([
    ['喜欢吃苹果', '水果偏好'],
    ['爱打篮球', '运动偏好'],
    ['喜欢喝咖啡', '饮品偏好'],
    ['爱吃火锅', '食物偏好'],
    ['爱听周杰伦的歌', '音乐偏好'],
    ['喜欢看电影', '影视偏好'],
    ['爱读书', '书籍偏好'],
    ['喜欢打游戏', '游戏偏好'],
    ['喜欢养猫', '宠物偏好'],
    ['习惯早起', '作息偏好'],
    ['莫名其妙的东西', '偏好'],
  ])('分类：%s → %s', (pref, expected) => {
    expect(classifyPreference(pref)).toBe(expected)
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
    '不用', '不要', '算了', '不', '别', '取消', 'no', '再说说',
    '今天天气怎么样', '播放音乐', '',
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
