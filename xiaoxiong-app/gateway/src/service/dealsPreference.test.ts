import { describe, expect, it } from 'vitest'
import { pickDeals, preferenceKeywords } from './dealsPreference'
import type { Deal } from './deals'
import type { MemoryEntry } from './dataService'

const mem = (key: string, value: string): MemoryEntry => ({ key, value, createdAt: 0, updatedAt: 0 })

const deal = (title: string, tags: string[] = [], mall = '京东'): Deal => ({
  title,
  price: '1元',
  mall,
  tags,
  link: `https://x/${encodeURIComponent(title)}`,
})

describe('preferenceKeywords', () => {
  it('中文长句拆出 2 字片段：喜欢喝咖啡 → 能匹配「咖啡」', () => {
    const kw = preferenceKeywords([mem('偏好', '喜欢喝咖啡')])
    expect(kw).toContain('咖啡')
  })

  it('分隔符切分：常买 猫粮、咖啡豆 都成为关键词', () => {
    const kw = preferenceKeywords([mem('常买', '猫粮、咖啡豆')])
    expect(kw).toEqual(expect.arrayContaining(['猫粮', '咖啡豆']))
  })

  it('空泛词与单字不参与匹配', () => {
    const kw = preferenceKeywords([mem('习惯', '喜欢 买 的 东西 时间')])
    expect(kw).not.toContain('喜欢')
    expect(kw).not.toContain('东西')
    expect(kw).not.toContain('买')
  })

  it('英文偏好按词切分', () => {
    const kw = preferenceKeywords([mem('preference', 'coffee beans')])
    expect(kw).toEqual(expect.arrayContaining(['coffee', 'beans']))
  })
})

describe('pickDeals', () => {
  const deals = [deal('无线蓝牙耳机'), deal('云南咖啡豆 500g'), deal('猫粮 10kg'), deal('保温杯')]

  it('命中偏好的排前面，其余按原顺序补齐', () => {
    const picked = pickDeals(deals, ['咖啡', '猫粮'], 3)
    expect(picked.map((d) => d.title)).toEqual(['云南咖啡豆 500g', '猫粮 10kg', '无线蓝牙耳机'])
  })

  it('没有记忆时等价于取前 limit 条（行为不变）', () => {
    expect(pickDeals(deals, [], 2).map((d) => d.title)).toEqual(['无线蓝牙耳机', '云南咖啡豆 500g'])
  })

  it('记忆全都没命中时也照常给出前 limit 条，不返回空列表', () => {
    const picked = pickDeals(deals, ['投影仪'], 2)
    expect(picked.map((d) => d.title)).toEqual(['无线蓝牙耳机', '云南咖啡豆 500g'])
  })

  it('标签与商城同样参与匹配', () => {
    const picked = pickDeals([deal('某商品', ['历史低价']), deal('另一件')], ['历史低价'], 1)
    expect(picked[0].title).toBe('某商品')
  })
})
