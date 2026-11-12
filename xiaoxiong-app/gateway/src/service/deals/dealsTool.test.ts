import { describe, it, expect, vi } from 'vitest'
import { createDealsTool, DEALS_TOOL_NAME } from '../tools/dealsTool'
import { createToolkit } from '../tools'
import { filterDeals, formatDeals, splitKeywordTerms, type Deal, type DealsFetcher } from './types'
import { createSmzdmSource, parseDeals, parseTagDeals } from './smzdm'

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

describe('parseTagDeals（tag 搜索页）', () => {
  const TAG_HTML = `
<div>
  <div class="haojia-card-container" directlink="https://detail.tmall.com/item.htm?id=981046147710" priceshow="97.2元">
    <div class="product-img-box"><a href="https://www.smzdm.com/p/185824877/"><img class="product-img" src="https://y.zdmimg.com/202601/29/697b7d4c29d136417.png_a640.jpg"></a></div>
    <div class="card-right-box">
      <a href="https://www.smzdm.com/p/185824877/" class="title-normal-box card-right-box-title">华为 FreeBuds SE 4 ANC降噪版 真无线蓝牙降噪耳机</a>
      <a href="https://www.smzdm.com/p/185824877/" class="sub-title-box card-right-box-sub-title">97.2元</a>
      <div class="tags-box"><a class="tags-item"> 价格低于618</a><a class="tags-item"> 百亿补贴</a></div>
    </div>
  </div>
  <div class="haojia-card-container">
    <div class="card-right-box">
      <a href="https://www.smzdm.com/p/185922391/" class="title-normal-box card-right-box-title">小米 Redmi Buds 6 活力版</a>
      <a href="https://www.smzdm.com/p/185922391/" class="sub-title-box card-right-box-sub-title">764.07元</a>
      <div class="tags-box"></div>
    </div>
  </div>
</div>
`

  it('解析标题/价格/标签/链接/图/商城，price 回退 priceshow', () => {
    const deals = parseTagDeals(TAG_HTML)
    expect(deals).toHaveLength(2)
    const [a, b] = deals
    expect(a.title).toBe('华为 FreeBuds SE 4 ANC降噪版 真无线蓝牙降噪耳机')
    expect(a.price).toBe('97.2元')
    expect(a.mall).toBe('天猫/淘宝')
    expect(a.link).toBe('https://www.smzdm.com/p/185824877/')
    expect(a.image).toBe('https://y.zdmimg.com/202601/29/697b7d4c29d136417.png_a640.jpg')
    expect(a.tags).toEqual(['价格低于618', '百亿补贴'])
    // 无 directlink 的条目商城留空不编造
    expect(b.mall).toBe('')
    expect(b.image).toBeUndefined()
  })

  it('WAF 挑战页（无卡片）解析为空数组', () => {
    expect(parseTagDeals('<html><body>安全验证</body></html>')).toHaveLength(0)
  })
})

describe('filterDeals', () => {
  const deals = parseDeals(SAMPLE_HTML)

  it('splitKeywordTerms：复合词剥品类后缀，单词/空格词保持', () => {
    expect(splitKeywordTerms('降噪耳机')).toEqual(['降噪', '耳机'])
    expect(splitKeywordTerms('蓝牙耳机')).toEqual(['蓝牙', '耳机'])
    expect(splitKeywordTerms('耳机')).toEqual(['耳机'])
    expect(splitKeywordTerms('无线 键盘')).toEqual(['无线', '键盘'])
    expect(splitKeywordTerms('咖啡机')).toEqual(['咖啡机'])
    expect(splitKeywordTerms('')).toEqual([])
  })

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

  it('复合关键词拆词 AND 匹配：拆写标题也能命中（回退场景）', () => {
    const list = [
      { title: '真无线降噪 蓝牙耳机', price: '', mall: '京东', tags: [], link: '' },
      { title: '无线蓝牙耳机', price: '', mall: '天猫', tags: [], link: '' },
      { title: '降噪充电宝', price: '', mall: '京东', tags: [], link: '' },
      { title: '蓝牙音箱', price: '', mall: '京东', tags: [], link: '' },
      { title: '耳机收纳包', price: '', mall: '京东', tags: [], link: '' },
    ] as Deal[]
    // 「降噪耳机」→ [降噪, 耳机]：两个词段都要出现，拆写标题不再漏
    expect(filterDeals(list, '降噪耳机').map((d) => d.title)).toEqual([
      '真无线降噪 蓝牙耳机',
    ])
    // 「蓝牙耳机」→ [蓝牙, 耳机]
    expect(filterDeals(list, '蓝牙耳机').map((d) => d.title)).toEqual([
      '真无线降噪 蓝牙耳机',
      '无线蓝牙耳机',
    ])
    // 单词等价整串 includes
    expect(filterDeals(list, '充电宝').map((d) => d.title)).toEqual(['降噪充电宝'])
    // 空格分隔的多词同样 AND
    expect(filterDeals(list, '无线 耳机').map((d) => d.title)).toEqual([
      '真无线降噪 蓝牙耳机',
      '无线蓝牙耳机',
    ])
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
    // 默认搜索优先：tag 1 次（404 失败）+ 回退 feed 2 页，共 3 次
    expect(f).toHaveBeenCalledTimes(3)
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

  // ── tag 搜索（站内真搜索）：能搜到 feed 之外的商品 ──

  const TAG_HTML = `
<div>
  <div class="haojia-card-container" directlink="https://detail.tmall.com/item.htm?id=981046147710" priceshow="97.2元">
    <div class="product-img-box"><a href="https://www.smzdm.com/p/185824877/"><img class="product-img" src="https://y.zdmimg.com/202601/29/697b7d4c29d136417.png_a640.jpg"></a></div>
    <div class="card-right-box">
      <a href="https://www.smzdm.com/p/185824877/" class="title-normal-box card-right-box-title">华为 FreeBuds SE 4 ANC降噪版 真无线蓝牙降噪耳机</a>
      <a href="https://www.smzdm.com/p/185824877/" class="sub-title-box card-right-box-sub-title">97.2元</a>
      <div class="tags-box"><a class="tags-item"> 价格低于618</a><a class="tags-item"> 百亿补贴</a></div>
    </div>
  </div>
  <div class="haojia-card-container">
    <div class="product-img-box"><a href="https://www.smzdm.com/p/185922391/"><img class="product-img" src="https://y.zdmimg.com/x.png_a640.jpg"></a></div>
    <div class="card-right-box">
      <a href="https://www.smzdm.com/p/185922391/" class="title-normal-box card-right-box-title">小米 Redmi Buds 6 活力版</a>
      <a href="https://www.smzdm.com/p/185922391/" class="sub-title-box card-right-box-sub-title">764.07元</a>
      <div class="tags-box"></div>
    </div>
  </div>
</div>
`

  it('带关键词且 tag 搜索命中：直接用搜索结果，不抓 feed', async () => {
    // searchUrl 会 encodeURIComponent，测试 key 用编码后的 URL
    const tagUrl = `https://www.smzdm.com/tag/%E8%80%B3%E6%9C%BA/`
    const f = vi.fn(fetcherFor({ [tagUrl]: { ok: true, body: TAG_HTML } }))
    const tool = createDealsTool('zh-CN', { source, fetcher: f })
    const out = await tool.call?.({ keyword: '耳机', dealsOnly: false })
    // 只抓了 tag 搜索页一跳，没抓 jingxuan feed
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).toBe(tagUrl)
    expect(out).toContain('华为 FreeBuds SE 4')
    expect(out).not.toContain('全棉时代')
  })

  it('dealsOnly=true（说了优惠/好价）：限定好价 feed，不打 tag 搜索', async () => {
    const f = vi.fn(
      fetcherFor({ 'https://www.smzdm.com/jingxuan/': { ok: true, body: SAMPLE_HTML } })
    )
    const tool = createDealsTool('zh-CN', { source, fetcher: f, keywordPages: 1 })
    const out = await tool.call?.({ keyword: '京东', dealsOnly: true })
    expect(out).toContain('查到 2 件')
    // 只抓了 feed 一页
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('搜索页 404/WAF 挑战：纯商品搜索回退 feed + 本地过滤（保底不比原来差）', async () => {
    const f = fetcherFor({ 'https://www.smzdm.com/jingxuan/': { ok: true, body: SAMPLE_HTML } })
    const tool = createDealsTool('zh-CN', { source, fetcher: f })
    // 「棉柔巾」tag 大概率不存在（404），回退后命中 feed 里的标题
    const out = await tool.call?.({ keyword: '棉柔巾', dealsOnly: false })
    expect(out).toContain('全棉时代婴儿棉柔巾')
  })

  it('搜索页返回挑战页（202）视同失败，回退 feed', async () => {
    const f = fetcherFor({
      'https://www.smzdm.com/tag/%E8%80%B3%E6%9C%BA/': { ok: false, status: 202, body: '' },
      'https://www.smzdm.com/jingxuan/': { ok: true, body: SAMPLE_HTML },
    })
    const tool = createDealsTool('zh-CN', { source, fetcher: f })
    // 回退后按本地过滤，样例里两条商城都是「京东」
    const out = await tool.call?.({ keyword: '耳机', dealsOnly: false })
    expect(out).toContain('没找到')
  })
})

describe('createToolkit 登记 query_deals', () => {
  it('工具集包含 query_deals', () => {
    const schemas = createToolkit('zh-CN').getJSONSchemas()
    expect(schemas.some((s) => s.function.name === DEALS_TOOL_NAME)).toBe(true)
  })
})
