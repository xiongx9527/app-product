import { describe, it, expect } from 'vitest'
import { classifyPreference, FALLBACK_CATEGORY } from '../../../../src/service/skills/preference_skill/preferenceCategory'

describe('偏好分类：确定性词表，不靠 LLM（避免把「喜欢打乒乓球」抽成「下来」）', () => {
  it('用户实测场景：乒乓球 → 运动', () => {
    expect(classifyPreference('喜欢打乒乓球')).toBe('运动')
    expect(classifyPreference('爱打羽毛球')).toBe('运动')
  })

  it('苹果 → 饮食，周杰伦 → 音乐', () => {
    expect(classifyPreference('爱吃苹果')).toBe('饮食')
    expect(classifyPreference('喜欢喝咖啡')).toBe('饮食')
    expect(classifyPreference('爱听周杰伦的歌')).toBe('音乐')
  })

  it('年龄/身高 → 个人信息', () => {
    expect(classifyPreference('我今年三十岁')).toBe('个人信息')
    expect(classifyPreference('身高一米七五')).toBe('个人信息')
  })

  it('生日归个人信息，不归社交', () => {
    expect(classifyPreference('生日是五月一号')).toBe('个人信息')
  })

  it('15 个分类都可达', () => {
    const cases: Array<[string, string]> = [
      ['打篮球', '运动'], ['吃火锅', '饮食'], ['听音乐', '音乐'], ['看电影', '影视'],
      ['读小说', '阅读'], ['早起', '作息'], ['去旅游', '出行'], ['养猫', '宠物'],
      ['打游戏', '游戏'], ['学英语', '学习'], ['养生', '健康'], ['和朋友聚会', '社交'],
      ['三十岁', '个人信息'], ['我是本科毕业', '教育'], ['我老婆叫小明', '家庭'],
    ]
    for (const [v, k] of cases) expect(classifyPreference(v)).toBe(k)
  })

  it('匹配不到回退「偏好」，绝不产生垃圾分类', () => {
    expect(classifyPreference('喜欢那个')).toBe(FALLBACK_CATEGORY)
    expect(classifyPreference('')).toBe(FALLBACK_CATEGORY)
    expect(classifyPreference('下来')).toBe(FALLBACK_CATEGORY)
  })
})
