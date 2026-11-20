/**
 * 值值值（zhizhizhi.com）好价数据源：smzdm 被 WAF 普遍拦截后的降级源。
 *
 * 站点特点（2026-11-17 实测）：
 * - 首页 /c/<分类> 列表页是静态 HTML，含真实商品（标题/价格/商城/图），设备网络可访问；
 * - 没有可用的关键词搜索接口（?s=xxx 返回 404），故按关键词映射到分类页 + 本地过滤。
 *
 * 本源不绑定全局 fetch，抓取器由工具层注入。
 */
import type { Deal, DealsSource } from '../types'

const BASE = 'https://www.zhizhizhi.com'
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'

/** 关键词 → 值值值分类 slug。命中则抓对应分类页，命中率比首页高得多。 */
const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/空调|冰箱|洗衣机|电视|家电|电器|热水器|油烟机|风扇|扫地机|吸尘器/, 'jiadian'],
  [/手机|电脑|笔记本|耳机|平板|相机|数码|键盘|鼠标|显示器|充电/, 'shuma'],
  [/衣服|鞋|包|服饰|女装|男装|运动鞋/, 'fushi'],
  [/食品|零食|牛奶|咖啡|茶叶|保健|苹果|水果/, 'shipin'],
  [/母婴|奶粉|尿不湿|玩具|婴儿|宝宝/, 'muying'],
  [/护肤|化妆品|面膜|洗护|美容|牙膏/, 'meirong'],
  [/家具|家居|沙发|床垫|收纳|厨房|家纺/, 'jujia'],
  [/运动|户外|健身|自行车|帐篷/, 'yundong'],
]

function categoryFor(keyword: string): string {
  for (const [re, slug] of CATEGORY_HINTS) if (re.test(keyword)) return slug
  return ''
}

/** 解码 HTML 实体（值值值标题里有 &nbsp; 等）。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 解析值值值列表页 HTML 为 Deal[]。单条结构（实测）：
 *   <div class="post_item">
 *     <img src="https://img.zhizhizhi.com/..." alt="标题">
 *     <div class="ht3">标题</div>
 *     <div class="dprice">1748元（含国补）</div>
 *     <a href="https://www.zhizhizhi.com/shop/jd">京东商城</a> ...
 * 只取页面真实存在的字段，不计算折扣。
 */
export function parseZhizhizhiHtml(html: string): Deal[] {
  const deals: Deal[] = []
  const items = html.split(/<div class="post_item["\s>]/).slice(1)
  for (const item of items) {
    // 标题：设备/WAP 版用 <h3>，PC 版用 <div class="ht3">，两种都要认
    const titleM = /<h3[^>]*>\s*([^<]+?)\s*<\/h3>/.exec(item)
      ?? /class="ht3"[^>]*>\s*([^<]+?)\s*<\/div>/.exec(item)
    const priceM = /class="dprice"[^>]*>\s*([^<]+?)\s*<\/div>/.exec(item)
    const linkM = /href="(https:\/\/www\.zhizhizhi\.com\/(?:n|g)\/[^"]+)"/.exec(item)
    if (!titleM || !priceM || !linkM) continue
    const title = decodeEntities(titleM[1])
    const price = decodeEntities(priceM[1])
    const link = linkM[1]
    const imgM = /<img[^>]*src="(https:\/\/img\.zhizhizhi\.com\/[^"]+)"/.exec(item)
    const mallM = /class="post_misc[^>]*>[\s\S]*?href="https:\/\/www\.zhizhizhi\.com\/shop\/[^"]+"[^>]*>([^<]+)</.exec(item)
    let mall = mallM ? decodeEntities(mallM[1]) : ''
    if (!mall) {
      if (/jd/i.test(item)) mall = '京东'
      else if (/tmall|taobao/i.test(item)) mall = '天猫'
      else if (/pinduoduo/i.test(item)) mall = '拼多多'
    }
    deals.push({
      title,
      price,
      mall,
      tags: [],
      link,
      ...(imgM ? { image: imgM[1] } : {}),
      sourceKey: 'zhizhizhi',
    })
  }
  return deals
}

/** 该源需要对搜索结果再做本地关键词过滤（分类页不是精确搜索）。 */
export const ZHIZHIZHI_FILTER_SEARCH = true

/** 创建值值值降级源：关键词→分类页，解析列表。无详情页（列表已含链接）。 */
export function createZhizhizhiSource(): DealsSource & { categoryFor(keyword: string): string } {
  return {
    name: 'zhizhizhi',
    baseUrl: `${BASE}/`,
    userAgent: USER_AGENT,
    filterSearch: true,
    categoryFor,
    pageUrl(page: number) {
      return page <= 1 ? `${BASE}/` : `${BASE}/page/${page}/`
    },
    parse: parseZhizhizhiHtml,
    // 关键词→分类页（比首页命中率高）；只第一页，多页由上层 feed 兜底
    searchUrl(keyword: string, page: number) {
      if (page > 1) return ''
      const cat = categoryFor(keyword)
      return cat ? `${BASE}/c/${cat}` : ''
    },
    parseSearch: parseZhizhizhiHtml,
  }
}

/** 供工具层抓取时带的 UA（设备访问值值值需移动 UA 才稳定）。 */
export const ZHIZHIZHI_UA = USER_AGENT
