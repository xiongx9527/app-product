import { load } from 'cheerio'
import type { Deal, DealDetail, DealsSource } from '../types'

/**
 * 缩略图 → 大图。smzdm 的图片地址形如 `<hash>.jpg_d200.jpg`，末尾尺寸后缀可换成 _d800
 * 拿到清晰原图（实测同一张 18KB → 140KB，200px 直接铺详情封面会糊）。
 * 只改尺寸段，其它原样保留；认不出后缀就返回空，由调用方回退缩略图。
 */
function toLargeImage(url: string): string | undefined {
  if (!url) return undefined
  const big = url.replace(/_([a-z])\d+(\.(?:jpe?g|png|webp))$/i, (_m, kind: string, ext: string) => `_${kind}800${ext}`)
  return big === url ? undefined : big
}

/** 解析「什么值得买 · 精选好价」列表页 HTML（纯函数，便于测试）。 */
export function parseDeals(html: string): Deal[] {
  const $ = load(html)
  const out: Deal[] = []
  $('li.J_feed_za').each((_, el) => {
    const li = $(el)
    const title = li.find('h5.feed-block-title a').first().text().trim()
    const price = li.find('.z-highlight').first().text().trim()
    const link = (li.find('.feed-block-title a').first().attr('href') || '').trim()
    if (!title && !price) return
    const tags: string[] = []
    li.find('.feed-block-tags i').each((_, t) => {
      const x = $(t).text().trim()
      if (x) tags.push(x)
    })
    li.find('a.tag-level1').each((_, t) => {
      const x = $(t).text().trim()
      if (x) tags.push(x)
    })
    // 商城名藏在「去购买」按钮 onclick 的 mall_name 里（属性值里单引号转义成 ''）。
    let mall = ''
    const oc = li.find('a.z-btn-red').first().attr('onclick') || ''
    const m = oc.match(/mall_name['"]?\s*:\s*['"]([^'"]*)['"]/)
    if (m) mall = m[1].trim()
    const tsRaw = li.attr('timesort')
    const time = tsRaw ? Number(tsRaw) : NaN
    // 商品主图：懒加载常放在 data-original/data-src，回退 src；协议相对 // 补 https。
    // 不同数据源图片类名不一，先找图片容器、再回退第一个 img；data: 内联占位图不算。
    const img = li.find('.z-feed-img img, .feed-block-img img').first()
    const imgEl = img.length ? img : li.find('img').first()
    let rawImage = (
      imgEl.attr('data-original') ||
      imgEl.attr('data-src') ||
      imgEl.attr('src') ||
      ''
    ).trim()
    if (rawImage.startsWith('data:')) rawImage = ''
    const image = rawImage
      ? rawImage.startsWith('//')
        ? `https:${rawImage}`
        : rawImage
      : undefined
    out.push({
      title,
      price,
      mall,
      tags,
      link,
      time: Number.isFinite(time) ? time : undefined,
      image,
      imageLarge: toLargeImage(image ?? ''),
      sourceKey: 'smzdm',
    })
  })
  return out
}

/**
 * 解析详情页 HTML → 补充信息。详情页信息比列表页全：
 * - og:description 就是优惠说明（「京东售价 256.44 元，领券后实付 91.14 元」），比列表标签有用；
 * - JSON-LD 的 pubDate 是权威发布时间（列表页 timesort 只是排序时间，会有偏差）；
 * - og:image 是主图，同样能换 _d800 拿清晰图。
 * 解析不出的一律留空，不抛错——详情页改版不该让整张卡片打不开。
 */
export function parseDealDetail(html: string): DealDetail {
  const out: DealDetail = {}
  const $ = load(html)

  const desc = ($('meta[property="og:description"]').attr('content') || '').trim()
  // 详情页的 og:description 有时是站点通用描述，过长/过短都当没有
  if (desc && desc.length <= 300) out.desc = desc

  // 品牌：详情页内嵌的 data.brand（列表页没有）
  const brand = html.match(/"brand"\s*:\s*"([^"]{1,30})"/)?.[1]?.trim()
  if (brand) out.brand = brand

  // JSON-LD：{ "pubDate": "2026-11-11T18:27:33" }，站点显示的是北京时间，补 +08:00 再解析，
  // 避免网关跑在别的时区时整体偏几小时。
  const pub = html.match(/"pubDate"\s*:\s*"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})"/)
  if (pub) {
    const ms = Date.parse(`${pub[1]}+08:00`)
    if (Number.isFinite(ms)) out.time = Math.floor(ms / 1000)
  }

  const og = ($('meta[property="og:image"]').attr('content') || '').trim()
  if (og) {
    const large = toLargeImage(og.startsWith('//') ? `https:${og}` : og)
    if (large) out.imageLarge = large
  }
  return out
}

/**
 * 创建「什么值得买 · 精选好价」数据源。baseUrl 缺省读 DEALS_SOURCE_URL 或内置默认。
 * 分页规则：首页 + p2/、p3/……（站点实时更新，约 20 条/页）。
 */
export function createSmzdmSource(baseUrl?: string): DealsSource {
  const base =
    baseUrl ?? process.env.DEALS_SOURCE_URL ?? 'https://www.smzdm.com/jingxuan/'
  return {
    name: 'smzdm',
    baseUrl: base,
    pageUrl(page: number) {
      if (page <= 1) return base
      const sep = base.endsWith('/') ? '' : '/'
      return `${base}${sep}p${page}/`
    },
    parse: parseDeals,
    // 列表项自带详情页链接，直接复用；没有链接就不补详情
    detailUrl: (deal) => deal.link || undefined,
    parseDetail: parseDealDetail,
  }
}
