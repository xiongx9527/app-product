/**
 * 值值值（zhizhizhi.com）好价数据源：smzdm 被 WAF 普遍拦截后的降级源。
 *
 * 站点特点（2026-11-17 实测）：
 * - 首页 /c/<分类> 列表页是静态 HTML，含真实商品（标题/价格/商城/图），设备网络可访问；
 * - 没有可用的关键词搜索接口（?s=xxx 返回 404），故按关键词映射到分类页 + 本地过滤。
 *
 * 本源不绑定全局 fetch，抓取器由工具层注入。
 */
import type { Deal, DealDetail, DealsSource } from '../types'

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

/**
 * 详情页补充信息 → 通用 DealDetail 契约（与什么值得买共用同一组字段）。
 * 只取页面真实渲染的字段，解析不出就留空；绝不因为详情页改版让卡片打不开。
 *
 * 每张详情页可稳定抓到（2026-11-24 实测 /n/drvoe）：
 * - meta[name=description]：购买方案（店铺、面价、领券步骤），作 desc；
 * - 优惠说明尖括号里的「店铺 XXX」；
 * - 常购价 / 30天最低 / 618价 / 双11价的价格分析（只收有数值的，'-' 跳过）；
 * - 品牌：<a>；发布于 YYYY-M-D HH:mm；og 图或首张 upfiles 主图（大图槽位）。
 */
export function parseZhizhizhiDetail(html: string): DealDetail {
  const out: DealDetail = {}

  // 购买方案：meta[name=description]，值值值把它写成「标题. 购买方案 1 店铺 ... 2 领券 ...」。
  // 去掉标题前缀、压到合理长度；过长/站点通用描述都当没有。
  const meta = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)?.[1] ?? ''
  let desc = decodeEntities(meta)
  const planAt = desc.indexOf('购买方案')
  if (planAt > 0) desc = desc.slice(planAt)
  desc = desc.trim()
  // meta 可能是站点按字数截断的，末尾常留半个「（领取链」这类残词，去掉未闭合的括号段。
  desc = desc.replace(/[（(][^）)]*$/, '').trim()
  if (desc && desc.length <= 300) out.desc = desc

  // 店铺名：购买方案里的「店铺 XXX，」或「店铺 XXX,」；只取短的一段。
  const shop = /店铺\s+([^,，。;；]{1,40})/.exec(meta)?.[1]
  if (shop) out.shop = decodeEntities(shop)

  // 品牌：底部「品牌：<a ...>名称</a>」。
  const brand = /品牌：\s*<a[^>]*>\s*([^<]{1,40}?)\s*<\/a>/.exec(html)?.[1]
  if (brand) out.brand = decodeEntities(brand)

  // 历史价格：遍历 des/price 对，只收有真实数值的（'-' / 空跳过），拼成可读串。
  // price 容器里常带 <em>¥</em> 标签，去掉标签再判断。
  const history: string[] = []
  for (const m of html.matchAll(/class="des">([^<]+)<\/div>\s*<div class="price">([\s\S]*?)<\/div>/g)) {
    const label = decodeEntities(m[1])
    const value = decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim()
    if (value && value !== '-' && /[0-9]/.test(value)) history.push(`${label} ${value}`)
  }
  if (history.length) out.historyPrices = history.join('、')

  // 发布时间：「发布于 2026-4-17 10:20」，按本地时区（网关在用户机器上）。
  const pub = /发布于\s*(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(html)
  if (pub) {
    const ts = new Date(+pub[1], +pub[2] - 1, +pub[3], +pub[4], +pub[5]).getTime()
    if (Number.isFinite(ts) && ts > 0) out.time = Math.floor(ts / 1000)
  }

  // 大图：优先 og:image，否则首张 upfiles 商品主图（排除站徽 220x220）。
  const og = /<meta\s+property="og:image"\s+content="([^"]+)"/i.exec(html)?.[1]
  const mainImg = /<img[^>]*src="(https:\/\/img\.zhizhizhi\.com\/upfiles\/[^"]+)"/.exec(html)?.[1]
  const image = og || mainImg
  if (image && !/220x220/.test(image)) out.imageLarge = decodeEntities(image)

  return out
}

/** 该源需要对搜索结果再做本地关键词过滤（分类页不是精确搜索）。 */
export const ZHIZHIZHI_FILTER_SEARCH = true

/** 创建值值值源：关键词→分类页，解析列表 + 详情页补充（映射通用 DealDetail）。 */
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
    // 列表项 link 就是详情页地址，选中后补抓
    detailUrl(deal: Deal) {
      return deal.link || undefined
    },
    parseDetail: parseZhizhizhiDetail,
  }
}

/** 供工具层抓取时带的 UA（设备访问值值值需移动 UA 才稳定）。 */
export const ZHIZHIZHI_UA = USER_AGENT
