import { describe, it, expect } from 'vitest'
import { detectProductQuery } from '../../../src/service/control/productCatalog'

describe('detectProductQuery 品牌识别', () => {
  it.each([
    // 品牌 + 品类：必须保留品牌，不能只留品类词（否则搜出其它品牌）
    ['帮我推荐华为手机', '华为手机'],
    ['推荐苹果手机', '苹果手机'],
    ['想买小米手机', '小米手机'],
    ['来一台华为平板电脑', '华为平板电脑'],
    ['推荐最新款华为手机', '华为手机'],
    ['帮我推荐oppo手机', 'oppo手机'],
    ['买个索尼耳机', '索尼耳机'],
    ['推荐一款格力空调', '格力空调'],
    ['看看戴森吹风机', '戴森吹风机'],
    // 纯品类（无品牌）：保持品类词
    ['推荐一款空调', '空调'],
    ['帮我推荐手机', '手机'],
    ['想买耳机', '耳机'],
    // 内容类不能被商品词劫持
    ['推荐一部电影', null],
    ['来段相声', null],
  ])('%s → keyword=%s', (text, expected) => {
    expect(detectProductQuery(text)?.keyword ?? null).toBe(expected)
  })
})
