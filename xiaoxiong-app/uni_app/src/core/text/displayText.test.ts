import { describe, expect, it } from 'vitest'
import { toDisplayText } from './displayText'

describe('toDisplayText', () => {
  it('去掉加粗、行内代码与链接语法，只留文字', () => {
    expect(toDisplayText('**注意**：请点 `设置` 里的 [语言](https://x.com) 选项')).toBe(
      '注意：请点 设置 里的 语言 选项'
    )
  })

  it('标题与无序列表转成可读的行', () => {
    expect(toDisplayText('### 今日天气\n- 晴\n- 26 度')).toBe('今日天气\n· 晴\n· 26 度')
  })

  it('HTML 换行标签转成换行，其余标签丢弃', () => {
    expect(toDisplayText('第一行<br/>第二行<span>重点</span>')).toBe('第一行\n第二行重点')
  })

  it('还原 HTML 实体', () => {
    expect(toDisplayText('A &amp; B&nbsp;好')).toBe('A & B 好')
  })

  it('代码块保留内容去掉围栏', () => {
    expect(toDisplayText('```js\nconst a = 1\n```')).toBe('const a = 1')
  })

  it('表格分隔行不显示，竖线收成空格', () => {
    expect(toDisplayText('| 城市 | 温度 |\n| --- | --- |\n| 北京 | 26 |')).toBe(
      '城市 温度\n北京 26'
    )
  })

  it('压缩多余空行并去掉首尾空白', () => {
    expect(toDisplayText('\n\n你好\n\n\n\n世界  \n')).toBe('你好\n\n世界')
  })

  it('空串与纯空白返回空串', () => {
    expect(toDisplayText('')).toBe('')
    expect(toDisplayText('   \n  ')).toBe('')
  })

  it('普通中文句子不被改动', () => {
    expect(toDisplayText('我在，今天北京多云，26 度。')).toBe('我在，今天北京多云，26 度。')
  })
})
