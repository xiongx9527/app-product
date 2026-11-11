import { describe, it, expect, vi } from 'vitest'
import { createDealsTool, DEALS_TOOL_NAME } from '../tools/dealsTool'
import { createToolkit } from '../tools'
import { filterDeals, formatDeals, type DealsFetcher } from './types'
import { createSmzdmSource, parseDeals } from './smzdm'

/** 固定 HTML 片段，覆盖标题/价格/标签/商城/时间/链接的解析。 */
const SAMPLE_HTML = `
<ul>
  <li class="J_feed_za feed-row-wide" timesort="1794386285" articleid="3_185932776">
    <div class="feed-block z-hor-feed">
      <div class="z-feed-img"><img data-original="//img.xxx.com/a.jpg_d200.jpg" src="https://img.xxx.com/placeholder.gif" /></div>
      <div class="z-feed-content">
        <h5 class="feed-block-title">
          <a target="_blank" href="https://www.smzdm.com/p/185932776/">全棉时代婴儿棉柔巾 80 抽 24 包</a>
        </h5>
        <a class="z-highlight" target="_blank" href="https://www.smzdm.com/p/185932776/">200元</a>
        <div class="feed-block-info">
          <span class="feed-block-tags">
            <i>历史低价</i>
            <i>商品好评率100%</i>
          </span>
        </div>
        <a class="tag-level1" target="_blank" href="https://www.smzdm.com/tag/tz/youhui/">手慢无</a>
        <a class="z-btn z-btn-red" target="_blank" onclick="gtmAddToCart({'mall':'京东','mall_name':'京东'})">去购买</a>
      </div>
    </div>
  </li>
  <li class="J_feed_za feed-row-wide" timesort="1794386000" articleid="3_185913064">
    <div class="feed-block z-hor-feed">
      <div class="z-feed-content">
        <h5 class="feed-block-title">
          <a target="_blank" href="https://www.smzdm.com/p/185913064/">大艺无刷电动扳手</a>
        </h5>
        <a class="z-highlight" target="_blank" href="https://www.smzdm.com/p/185913064/">106.84元</a>
        <div class="feed-block-info">
          <span class="feed-block-tags">
            <i>365天新低</i>
          </span>
        </div>
        <a class="z-btn z-btn-red" target="_blank" onclick="gtmAddToCart({'mall':'京东','mall_name':'京东'})">去购买</a>
      </div>
    </div>
  </li>
</ul>
`

describe('parseDeals', () => {
  it('解析出标题/价格/标签/商城/时间/链接', () => {
    const deals = parseDeals(SAMPLE_HTML)
    expect(deals).toHaveLength(2)
    const [a, b] = deals
    expect(a.title).toBe('全棉时代婴儿棉柔巾 80 抽 24 包')
    expect(a.price).toBe('200元')
    expect(a.mall).toBe('京东')
    expect(a.tags).toEqual(expect.arrayContaining(['历史低价', '商品好评率100%', '手慢无']))
    expect(a.time).toBe(1794386285)
    expect(a.link).toBe('https://www.smzdm.com/p/185932776/')
    // 懒加载主图取 data-original，协议相对 // 补 https
    expect(a.image).toBe('https://img.xxx.com/a.jpg_d200.jpg')
    // 缩略图换大图：只改尺寸段（_d200 → _d800），详情封面不糊
    expect(a.imageLarge).toBe('https://img.xxx.com/a.jpg_d800.jpg')

    expect(b.title).toBe('大艺无刷电动扳手')
    expect(b.price).toBe('106.84元')
    expect(b.tags).toEqual(['365天新低'])
    // 无图条目：image / imageLarge 均缺省（换源/字段缺失时卡片需容忍）
    expect(b.image).toBeUndefined()
    expect(b.imageLarge).toBeUndefined()
  })

  it('缺标题和价格的空壳条目被跳过', () => {
    const html = `<ul><li class="J_feed_za"></li></ul>`
    expect(parseDeals(html)).toHaveLength(0)
  })
})

describe('filterDeals', () => {
  const deals = parseDeals(SAMPLE_HTML)

  it('关键词按标题/商城/标签过滤', () => {
    expect(filterDeals(deals, '扳手').map((d) => d.title)).toEqual(['大艺无刷电动扳手'])
    expect(filterDeals(deals, '京东')).toHaveLength(2)
    expect(filterDeals(deals, '手慢无').map((d) => d.title)).toEqual([
      '全棉时代婴儿棉柔巾 80 抽 24 包',
    ])
  })

  it('limit 收敛到 1–5 并截断', () => {
    expect(filterDeals(deals, undefined, 1)).toHaveLength(1)
    expect(filterDeals(deals, undefined, 99)).toHaveLength(2)
    expect(filterDeals(deals, undefined, 0)).toHaveLength(1)
  })

  it('空结果返回空数组', () => {
    expect(filterDeals(deals, '不存在的东西')).toHaveLength(0)
  })
})

describe('formatDeals', () => {
  const deals = parseDeals(SAMPLE_HTML)

  it('中文带条数、价格、商城、标签与提示语', () => {
    const text = formatDeals('zh-CN', deals)
    expect(text).toContain('查到 2 件最新好价')
    expect(text).toContain('全棉时代婴儿棉柔巾')
    expect(text).toContain('现价200元')
    expect(text).toContain('京东')
    expect(text).toContain('历史低价')
    expect(text).toContain('下单前以商品页为准')
  })

  it('空结果返回「没找到」类文案', () => {
    expect(formatDeals('zh-CN', [])).toContain('暂时没有查到好价')
    expect(formatDeals('zh-CN', [], '耳机')).toContain('没找到与「耳机」相关的好价')
  })

  it('英文本地化', () => {
    const text = formatDeals('en-US', deals)
    expect(text).toContain('Found 2 latest deals')
    expect(text).toContain('check the product page before ordering')
  })
})

describe('createDealsTool 抓取与降级', () => {
  const source = createSmzdmSource()
  function fetcherFor(map: Record<string, { ok: boolean; status?: number; body: string }>): DealsFetcher {
    return async (url: string) => {
      const hit = map[url]
      return {
        ok: hit?.ok ?? false,
        status: hit?.status ?? 404,
        text: async () => hit?.body ?? '',
      }
    }
  }

  it('无关键词只抓首页，返回格式化文本', async () => {
    const f = fetcherFor({ 'https://www.smzdm.com/jingxuan/': { ok: true, body: SAMPLE_HTML } })
    const tool = createDealsTool('zh-CN', { source, fetcher: f })
    const out = await tool.call?.({})
    expect(out).toContain('查到 2 件最新好价')
  })

  it('有关键词并行抓多页并合并去重', async () => {
    const page1 = `https://www.smzdm.com/jingxuan/`
    const page2 = `https://www.smzdm.com/jingxuan/p2/`
    const f = fetcherFor({
      [page1]: { ok: true, body: SAMPLE_HTML },
      [page2]: { ok: true, body: SAMPLE_HTML },
    })
    const tool = createDealsTool('zh-CN', { source, fetcher: f, keywordPages: 3 })
    const out = await tool.call?.({ keyword: '京东' })
    // 两页内容相同，去重后应仍是 2 件
    expect(out).toContain('查到 2 件')
  })

  it('单页 HTTP 非 200 降级为空结果文案（不抛错）', async () => {
    const f = fetcherFor({ 'https://www.smzdm.com/jingxuan/': { ok: false, status: 503, body: '' } })
    const tool = createDealsTool('zh-CN', { source, fetcher: f })
    const out = await tool.call?.({})
    expect(out).toContain('暂时查不到好价信息')
  })

  it('全部抓取失败返回「暂时查不到」', async () => {
    const f = vi.fn(fetcherFor({}))
    const tool = createDealsTool('zh-CN', { source, fetcher: f, keywordPages: 2 })
    const out = await tool.call?.({ keyword: '耳机' })
    expect(out).toContain('暂时查不到好价信息')
    // 抓了 2 页
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('TTL 内第二次调用复用 Promise，不再触发 fetcher', async () => {
    const f = vi.fn(
      fetcherFor({ 'https://www.smzdm.com/jingxuan/': { ok: true, body: SAMPLE_HTML } })
    )
    const tool = createDealsTool('zh-CN', { source, fetcher: f, cacheTtlMs: 60000 })
    await tool.call?.({})
    await tool.call?.({})
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('工具名固定且不被本地化', () => {
    expect(DEALS_TOOL_NAME).toBe('query_deals')
    const en = createDealsTool('en-US', { source, fetcher: fetcherFor({}) })
    expect(en.name).toBe('query_deals')
    expect(en.description.toLowerCase()).toContain('deals')
  })
})

describe('createToolkit 登记 query_deals', () => {
  it('工具集包含 query_deals', () => {
    const schemas = createToolkit('zh-CN').getJSONSchemas()
    expect(schemas.some((s) => s.function.name === DEALS_TOOL_NAME)).toBe(true)
  })
})
