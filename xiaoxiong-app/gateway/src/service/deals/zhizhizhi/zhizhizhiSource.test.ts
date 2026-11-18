import { describe, it, expect } from 'vitest'
import { parseZhizhizhiHtml, createZhizhizhiSource } from './zhizhizhiSource'

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
})
