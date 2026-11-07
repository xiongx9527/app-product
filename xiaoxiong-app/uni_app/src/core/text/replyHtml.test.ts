import { describe, expect, it } from 'vitest'
import { sanitizeHtml, toReplyHtml } from './replyHtml'

describe('toReplyHtml', () => {
  it('Markdown 加粗、行内代码、链接转成 HTML', () => {
    const html = toReplyHtml('**注意**：点 `设置`，详见[说明](https://a.com)')
    expect(html).toContain('<strong>注意</strong>')
    expect(html).toContain('<code')
    expect(html).toContain('设置')
    expect(html).toContain('>说明</span>')
  })

  it('标题与无序列表转成块级结构', () => {
    const html = toReplyHtml('### 今日天气\n- 晴\n- 26 度')
    expect(html).toContain('今日天气')
    expect(html).toContain('<ul')
    expect(html.match(/<li/g)?.length).toBe(2)
  })

  it('代码块内容转义后放进 pre', () => {
    const html = toReplyHtml('```\nif (a < b) x++\n```')
    expect(html).toContain('<pre')
    expect(html).toContain('a &lt; b')
  })

  it('普通换行变成 br，结尾不留多余 br', () => {
    expect(toReplyHtml('第一行\n第二行')).toBe('第一行<br/>第二行')
  })

  it('已经是 HTML 的原样保留', () => {
    const html = toReplyHtml('<div>你好</div><div>世界</div>')
    expect(html).toContain('<div>你好</div>')
    expect(html).toContain('<div>世界</div>')
  })

  it('行内 HTML 保留并把换行补成 br', () => {
    expect(toReplyHtml('<span>甲</span>\n<span>乙</span>')).toBe('<span>甲</span><br/><span>乙</span>')
  })

  it('去掉脚本、事件属性与 javascript 链接', () => {
    const html = toReplyHtml('<div onclick="x()">安全</div><script>alert(1)</script>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('script')
    expect(html).toContain('安全')
  })

  it('空内容返回空串', () => {
    expect(toReplyHtml('')).toBe('')
    expect(toReplyHtml('   ')).toBe('')
  })
})

describe('sanitizeHtml', () => {
  it('移除 iframe 与 style 块', () => {
    const html = sanitizeHtml('<style>body{}</style><iframe src="x"></iframe><p>正文</p>')
    expect(html).toBe('<p>正文</p>')
  })

  it('中和 javascript: 链接', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">点我</a>')).toBe('<a href="#">点我</a>')
    expect(sanitizeHtml('<a href=javascript:alert(1)>点我</a>')).toBe('<a href="#">点我</a>')
  })
})
