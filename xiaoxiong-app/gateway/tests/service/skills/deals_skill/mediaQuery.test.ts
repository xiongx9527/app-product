import { describe, it, expect, beforeEach } from 'vitest'
import { collectDeals, createDealsQuery, type DealsContext } from '../../../../src/service/skills/deals_skill/query'
import { resetSourceCooldowns } from '../../../../src/service/skills/deals_skill/deals/sourceCooldown'
import type { Deal, DealsSource } from '../../../../src/service/skills/deals_skill/deals'

const deal = (title: string, mall = '京东', tags: string[] = []): Deal => ({
  title, price: '9.9元', mall, tags, link: `https://x/${title}`,
})

const src = (name: string, items: Deal[]): DealsSource => ({
  name,
  baseUrl: 'https://x',
  pageUrl: (p) => `https://x/p${p}`,
  parse: () => items,
})

function ctx(source: DealsSource): DealsContext {
  return {
    source,
    fetchPage: async (_url, parse) => (parse ?? source.parse)('<html>'),
    keywordPages: 1,
  }
}

const LONG_HTML = '<html>' + 'x'.repeat(900) + '</html>'
const fakeFetcher = () => async () => ({
  ok: true,
  status: 200,
  text: async () => LONG_HTML,
}) as unknown as Response

describe('deals query：collectDeals 取数/去重/过滤', () => {
  beforeEach(() => resetSourceCooldowns())

  it('合并多页结果并按 link 去重', async () => {
    const d = deal('咖啡豆')
    const s: DealsSource = {
      ...src('s', []),
      keywordPages: 2,
      parse: (html) => (html.includes('p2') ? [d, d] : [d]),
    }
    const c: DealsContext = {
      source: s,
      fetchPage: async (url, parse) => (parse ?? s.parse)(url),
      keywordPages: 2,
    }
    const { deals, anyOk } = await collectDeals(c, { limit: 10 })
    expect(anyOk).toBe(true)
    expect(deals.map((x) => x.title)).toEqual(['咖啡豆'])
  })

  it('按关键词本地过滤（商品名/商城/标签命中）', async () => {
    const s = src('s', [deal('云南咖啡豆', '京东', ['新低']), deal('蓝牙耳机', '天猫')])
    const { deals } = await collectDeals(ctx(s), { keyword: '咖啡', limit: 5 })
    expect(deals.map((x) => x.title)).toEqual(['云南咖啡豆'])
  })
})

describe('deals query：createDealsQuery 多源降级', () => {
  beforeEach(() => resetSourceCooldowns())

  it('有结果时返回口播文本与结构化列表', async () => {
    const s = src('s', [deal('好商品')])
    const query = createDealsQuery('zh-CN', { source: s, fetcher: fakeFetcher() })
    const out = await query({ dealsOnly: true, limit: 3 })
    expect(out.deals.map((x) => x.title)).toEqual(['好商品'])
    expect(out.text).toContain('好商品')
  })

  it('所有源都无结果时返回「没找到」文案', async () => {
    const query = createDealsQuery('zh-CN', { source: src('s', []), fetcher: fakeFetcher() })
    const out = await query({ keyword: '不存在的商品', limit: 3 })
    expect(out.deals).toEqual([])
    expect(out.text).toContain('没找到')
  })
})
