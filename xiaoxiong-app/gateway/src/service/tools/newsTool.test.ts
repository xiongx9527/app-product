import { describe, it, expect, vi } from 'vitest'
import { createNewsTool } from './newsTool'
import { createBaiduNewsSource, parseNewsHtml } from '../news'
import type { NewsFetcher, NewsSource } from '../news'

// 中性话题的夹具 HTML（不触及任何敏感题材）：泛播页 + 话题页
const HOME_HTML = `
<div class="hotnews">
  <a href="#">科学家研发新型芯片取得突破</a>
  <a href="#">全国多地迎来降雨天气</a>
  <a href="#">体育联赛今日开赛</a>
</div>
`
const TOPIC_HTML = `
<div class="c-container">
  <h3><a>人工智能产业发展大会在沪举行</a></h3>
  <span class="source">科技日报</span>
</div>
<div class="c-container">
  <h3><a>新能源汽车销量持续增长</a></h3>
  <span class="source">财经网</span>
</div>
<div class="c-container">
  <h3><a>登录</a></h3>
</div>
`

function fetcherFor(map: Record<string, { ok: boolean; status: number; html: string }>): NewsFetcher {
  return vi.fn(async (url) => {
    const hit = map[url]
    if (!hit) return { ok: false, status: 404, text: async () => '' }
    return { ok: hit.ok, status: hit.status, text: async () => hit.html }
  })
}

describe('parseNewsHtml', () => {
  it('泛播页：多级选择器抓标题、去重、滤导航', () => {
    expect(parseNewsHtml(HOME_HTML)).toEqual([
      { title: '科学家研发新型芯片取得突破' },
      { title: '全国多地迎来降雨天气' },
      { title: '体育联赛今日开赛' },
    ])
  })

  it('话题页：抓标题并带来源，滤掉「登录」等导航词', () => {
    expect(parseNewsHtml(TOPIC_HTML)).toEqual([
      { title: '人工智能产业发展大会在沪举行', source: '科技日报' },
      { title: '新能源汽车销量持续增长', source: '财经网' },
    ])
  })

  it('验证页/空页解析出空数组，不编造', () => {
    expect(parseNewsHtml('<html>百度安全验证</html>')).toEqual([])
    expect(parseNewsHtml('<html></html>')).toEqual([])
  })
})

describe('createNewsTool', () => {
  const source = createBaiduNewsSource()

  it('泛播：抓头条页返回 headlines 且 ok=true', async () => {
    const url = source.headlinesUrl(null)
    const tool = createNewsTool({ source, fetcher: fetcherFor({ [url]: { ok: true, status: 200, html: HOME_HTML } }) })
    const r = await tool.query(null)
    expect(r.ok).toBe(true)
    expect(r.headlines.length).toBe(3)
  })

  it('带话题：走话题搜索 URL，解析带来源', async () => {
    const url = source.headlinesUrl('科技')
    expect(url).toContain('word=')
    const tool = createNewsTool({ source, fetcher: fetcherFor({ [url]: { ok: true, status: 200, html: TOPIC_HTML } }) })
    const r = await tool.query('科技')
    expect(r.ok).toBe(true)
    expect(r.headlines[0]).toEqual({ title: '人工智能产业发展大会在沪举行', source: '科技日报' })
  })

  it('话题已含「新闻」不重复追加', () => {
    const u = createBaiduNewsSource().headlinesUrl('科技新闻')
    expect(decodeURIComponent(u)).not.toContain('新闻新闻')
  })

  it('HTTP 非 200 / 验证页 → ok=false 诚实降级', async () => {
    const url = source.headlinesUrl(null)
    const bad = createNewsTool({ source, fetcher: fetcherFor({ [url]: { ok: false, status: 500, html: '' } }) })
    expect((await bad.query(null)).ok).toBe(false)
    const verify = createNewsTool({
      source,
      fetcher: fetcherFor({ [url]: { ok: true, status: 200, html: '请输入验证码' } }),
    })
    expect((await verify.query(null)).ok).toBe(false)
  })

  it('TTL 内并发复用同一请求，只 fetch 一次', async () => {
    const url = source.headlinesUrl(null)
    const f = fetcherFor({ [url]: { ok: true, status: 200, html: HOME_HTML } })
    const tool = createNewsTool({ source, fetcher: f })
    await Promise.all([tool.query(null), tool.query(null)])
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('换源：注入自定义 NewsSource 即可，不改工具', async () => {
    const custom: NewsSource = {
      name: 'custom',
      headlinesUrl: () => 'https://example.com/news',
      parse: () => [{ title: '自定义源新闻标题' }],
    }
    const tool = createNewsTool({
      source: custom,
      fetcher: fetcherFor({ 'https://example.com/news': { ok: true, status: 200, html: 'x' } }),
    })
    expect(tool.name).toBe('custom')
    expect((await tool.query(null)).headlines[0].title).toBe('自定义源新闻标题')
  })
})
