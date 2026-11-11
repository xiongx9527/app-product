import { load } from 'cheerio'
import type { Deal, DealsSource } from '../types'

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
    })
  })
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
  }
}
