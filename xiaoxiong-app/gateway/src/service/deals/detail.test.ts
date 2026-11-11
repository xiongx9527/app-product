import { describe, expect, it } from 'vitest'
import { toDetailItems } from './detail'
import type { Deal } from './types'

const deal: Deal = {
  title: '全棉时代婴儿棉柔巾',
  price: '200元',
  mall: '京东',
  tags: ['历史低价', '手慢无'],
  time: 1794386285,
  link: 'https://www.smzdm.com/p/xxx/',
  image: 'https://img.xxx/a.jpg',
}

describe('toDetailItems（统一字段契约）', () => {
  it('固定槽位只有 index/title/image/link，其余属性统一进 fields[]，不含来源专属字段', () => {
    const [item] = toDetailItems([deal], 'zh-CN')
    expect(item.index).toBe(1)
    expect(item.title).toBe(deal.title)
    expect(item.image).toBe(deal.image)
    expect(item.link).toBe(deal.link)
    // 关键：协议层不再有 price/mall/tags/time 这类来源专属字段
    const raw = item as unknown as Record<string, unknown>
    expect(raw.price).toBeUndefined()
    expect(raw.mall).toBeUndefined()
    expect(raw.tags).toBeUndefined()
    expect(raw.time).toBeUndefined()
    // 一切附加属性统一成 label+value
    expect(item.fields?.map((f) => f.label)).toEqual(['现价', '商城', '优惠', '发布时间'])
    expect(item.fields?.find((f) => f.label === '现价')?.value).toBe('200元')
    expect(item.fields?.find((f) => f.label === '优惠')?.value).toBe('历史低价、手慢无')
  })

  it('字段缺失容忍：新源没有图片/价格/商城/标签也不崩、不产生空 fields', () => {
    const sparse: Deal = { title: '只有标题', price: '', mall: '', tags: [], link: '' }
    const [item] = toDetailItems([sparse], 'zh-CN')
    expect(item.title).toBe('只有标题')
    expect(item.image).toBeUndefined()
    expect(item.link).toBeUndefined()
    expect(item.fields).toBeUndefined()
  })

  it('按顺序编号（index 从 1 开始）', () => {
    const items = toDetailItems([deal, { ...deal, title: '第二件' }], 'zh-CN')
    expect(items.map((i) => i.index)).toEqual([1, 2])
  })

  it('label 按会话 lang 本地化（换语言不改结构）', () => {
    const [item] = toDetailItems([deal], 'en-US')
    expect(item.fields?.map((f) => f.label)).toEqual(['Price', 'Store', 'Tags', 'Posted'])
  })

  it('发布时间：秒与毫秒时间戳都能格式化，且年份正确', () => {
    const asSec = toDetailItems([{ ...deal, time: 1794386285 }], 'zh-CN')[0]
    const asMs = toDetailItems([{ ...deal, time: 1794386285000 }], 'zh-CN')[0]
    const secVal = asSec.fields?.find((f) => f.label === '发布时间')?.value
    const msVal = asMs.fields?.find((f) => f.label === '发布时间')?.value
    expect(secVal).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(secVal).toBe(msVal)
    expect(secVal?.startsWith('2026-')).toBe(true)
  })

  it('发布时间：脏值不显示该行，绝不把 -1 年这类垃圾值摆上卡片', () => {
    // -1 年对应的时间戳（线上真实出现过的脏值）、1970 前、NaN
    for (const bad of [-62170012800, -1, 0, Number.NaN]) {
      const [item] = toDetailItems([{ ...deal, time: bad }], 'zh-CN')
      const labels = item.fields?.map((f) => f.label) ?? []
      expect(labels).not.toContain('发布时间')
    }
  })

  it('大图槽位透传（缺省时客户端回退缩略图）', () => {
    const [withLarge] = toDetailItems(
      [{ ...deal, imageLarge: 'https://img.xxx/a.jpg_d800.jpg' }],
      'zh-CN',
    )
    expect(withLarge.image).toBe('https://img.xxx/a.jpg')
    expect(withLarge.imageLarge).toBe('https://img.xxx/a.jpg_d800.jpg')
    const [noLarge] = toDetailItems([deal], 'zh-CN')
    expect(noLarge.imageLarge).toBeUndefined()
  })
})
