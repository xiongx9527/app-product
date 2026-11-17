import { load } from 'cheerio'
import type { NewsHeadline, NewsSource } from './types'

/** 百度新闻频道：泛播头条页 + 话题搜索页。地址只由网关持有，前端不出现。 */
const BAIDU_NEWS_HOME = 'https://news.baidu.com/'
const BAIDU_NEWS_SEARCH = 'https://news.baidu.com/ns'

/** 导航/固定文案，抓到这些整串标题要剔除，不播报 */
const NAV_TITLES =
  /^(百度新闻|新闻|登录|注册|更多|下一页|上一页|设置|帮助|首页|导航|点击进入|详情|展开|收起|返回|下载客户端)$/

/** 标题长度边界（过短可能是导航碎片，过长可能是整段正文） */
const TITLE_MIN = 6
const TITLE_MAX = 80

/**
 * 从百度新闻页 HTML 解析标题列表（纯函数）。
 * 用多级选择器阶梯，绝不依赖单一 class：取第一个产出 ≥1 条的选择器；都不行再兜底全页 <a> 筛。
 * 来源只在能定位到所在容器时从容器内取，取不到就省略、不猜、不编造。
 */
export function parseNewsHtml(html: string): NewsHeadline[] {
  const $ = load(html)
  // 话题页的选择器在前（结构更明确），泛播页在后；两者都试，谁先产出用谁
  const steps = [
    { title: '.c-container h3 a', scope: '.c-container' },
    { title: 'h3 a', scope: '' },
    { title: '#pane-news a', scope: '' },
    { title: 'div.hotnews a', scope: '' },
    { title: 'ul.news-list a', scope: '' },
    { title: 'div[class*=headline] a', scope: '' },
  ]

  const seen = new Set<string>()
  const out: NewsHeadline[] = []
  for (const step of steps) {
    const nodes = $(step.title).toArray()
    if (!nodes.length) continue
    for (const node of nodes) {
      const title = $(node).text().replace(/\s+/g, ' ').trim()
      if (title.length < TITLE_MIN || title.length > TITLE_MAX) continue
      if (NAV_TITLES.test(title)) continue
      if (seen.has(title)) continue
      seen.add(title)
      // 来源：话题页在容器内有 [class*=source]；首页通常取不到，省略
      let source: string | undefined
      if (step.scope) {
        const scopeNode = $(node).closest(step.scope)
        const s = scopeNode.find('[class*=source],[data-source]').first().text().replace(/\s+/g, ' ').trim()
        if (s && s.length <= 20) source = s
      }
      out.push(source ? { title, source } : { title })
      if (out.length >= 5) break
    }
    if (out.length) break // 本阶梯已产出，不再试后续选择器
  }
  return out
}

/** 百度新闻源。baseUrl 可覆盖（测试/换域名）；默认走官方新闻频道。 */
export function createBaiduNewsSource(baseUrl = BAIDU_NEWS_HOME): NewsSource {
  const home = baseUrl.replace(/\/$/, '')
  return {
    name: 'baidu-news',
    headlinesUrl(keyword) {
      if (!keyword) return home
      // 已含新闻类词则不重复追加，避免「科技新闻新闻」降低召回
      const q = /新闻|消息|头条|热点|快讯|news|headlines?/i.test(keyword)
        ? keyword
        : `${keyword} 新闻`
      return `${BAIDU_NEWS_SEARCH}?word=${encodeURIComponent(q)}`
    },
    parse: parseNewsHtml,
  }
}
