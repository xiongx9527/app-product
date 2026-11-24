import { describe, it, expect } from 'vitest'
import { parseZhizhizhiHtml, parseZhizhizhiDetail, createZhizhizhiSource } from '../../../../../../src/service/skills/deals_skill/deals/zhizhizhi/zhizhizhiSource'

/** 反映值值值真实列表页结构（post_item / ht3 / dprice / shop 链接） */
function html(items: Array<{ title: string; price: string; link: string; mall: string }>): string {
  return (
    '<div class="main_post_list">' +
    items
      .map(
        (d) =>
          `<div class="post_item"><div class="post_item_main"><div class="title_box">` +
          `<div class="ht3">${d.title}</div><div class="dprice">${d.price}</div></div>` +
          `<div class="post_misc"><a href="https://www.zhizhizhi.com/shop/${d.mall}">商城</a></div>` +
          `<a href="${d.link}">详</a><img src="https://img.zhizhizhi.com/upfiles/x.jpg"/>` +
          `</div></div>`
      )
      .join('') +
    '</div>'
  )
}

describe('parseZhizhizhiHtml', () => {
  it('解析标题/价格/商城/链接/图片，只取页面真实字段', () => {
    const deals = parseZhizhizhiHtml(
      html([
        {
          title: '格力 空调 1.5匹 新一级能效',
          price: '2299元（含国补）',
          link: 'https://www.zhizhizhi.com/n/abc',
          mall: 'jd',
        },
      ])
    )
    expect(deals).toHaveLength(1)
    expect(deals[0].title).toBe('格力 空调 1.5匹 新一级能效')
    expect(deals[0].price).toBe('2299元（含国补）')
    expect(deals[0].link).toBe('https://www.zhizhizhi.com/n/abc')
    expect(deals[0].sourceKey).toBe('zhizhizhi')
    expect(deals[0].image).toContain('img.zhizhizhi.com')
  })

  it('兼容设备/WAP 版标题 <h3> 结构', () => {
    const wap =
      '<div class="post_item"><div class="post_item_img"><img src="https://img.zhizhizhi.com/upfiles/a.jpg" alt="x"/></div>' +
      '<div class="post_item_main"><div class="title_box"><h3>美的 空调 1匹 一级能效</h3>' +
      '<div class="dprice">1999元</div></div><div class="footer_box"><span class="shop">' +
      '<a href="https://www.zhizhizhi.com/shop/jd">京东</a></span></div>' +
      '<a href="https://www.zhizhizhi.com/n/xyz">详</a></div></div>'
    const deals = parseZhizhizhiHtml(wap)
    expect(deals).toHaveLength(1)
    expect(deals[0].title).toBe('美的 空调 1匹 一级能效')
    expect(deals[0].price).toBe('1999元')
  })

  it('无商品项返回空数组', () => {
    expect(parseZhizhizhiHtml('<html><body>无内容</body></html>')).toEqual([])
  })
})

describe('createZhizhizhiSource', () => {
  it('关键词映射到分类页（空调→家电），未知词回退首页 feed', () => {
    const source = createZhizhizhiSource()
    expect(source.searchUrl?.('空调', 1)).toContain('/c/jiadian')
    expect(source.searchUrl?.('耳机', 1)).toContain('/c/shuma')
    expect(source.searchUrl?.('随便什么', 1)).toBe('')
    expect(source.searchUrl?.('空调', 2)).toBe('')
  })

  it('源声明移动 UA 与搜索结果本地过滤', () => {
    const source = createZhizhizhiSource()
    expect(source.userAgent).toContain('Android')
    expect(source.filterSearch).toBe(true)
  })

  it('详情地址 = 列表项 link；声明了通用详情解析', () => {
    const source = createZhizhizhiSource()
    expect(source.detailUrl?.({ title: 'x', price: '1元', mall: '', tags: [], link: 'https://www.zhizhizhi.com/n/abc' })).toBe('https://www.zhizhizhi.com/n/abc')
    expect(typeof source.parseDetail).toBe('function')
  })
})

describe('parseZhizhizhiDetail（映射到通用 DealDetail）', () => {
  const detailHtml =
    '<meta name="description" content="全友家居 飞鸟沙发. 购买方案 1 店铺 全友家居官方旗舰店 ,商品面价3523.75元 2 领券 国补至高30%"/>' +
    '<div class="price-analysis"><ul>' +
    '<li><div class="des">常购价</div><div class="price"><em>¥</em>2819</div></li>' +
    '<li><div class="des">30天最低</div><div class="price"><em>¥</em>2790.81</div></li>' +
    '<li><div class="des">618价</div><div class="price">-</div></li>' +
    '</ul></div>' +
    '<li>商家：<a href="x">京东商城</a> 品牌：<a href="y">全友家居 QUANU</a></li>' +
    '<div class="tit_bar_1_lf">发布于 2026-4-17 10:20</div>' +
    '<img src="https://img.zhizhizhi.com/upfiles/2026/04/main.jpg"/>'

  it('抓购买方案/店铺/品牌/历史价(跳过"-")/发布时间/大图', () => {
    const d = parseZhizhizhiDetail(detailHtml)
    expect(d.desc).toContain('购买方案')
    expect(d.shop).toBe('全友家居官方旗舰店')
    expect(d.brand).toBe('全友家居 QUANU')
    expect(d.historyPrices).toContain('常购价 ¥2819')
    expect(d.historyPrices).toContain('30天最低 ¥2790.81')
    expect(d.historyPrices).not.toContain('618')
    expect(d.imageLarge).toContain('upfiles')
    expect(d.time).toBeGreaterThan(0)
  })

  it('解析不出时返回空对象，不抛错', () => {
    expect(parseZhizhizhiDetail('<html>无详情</html>')).toEqual({})
  })
})
