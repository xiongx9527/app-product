import { describe, it, expect } from 'vitest'
import { detectDealsCommand } from './dealsControl'

/** 锁住「哪些话绕开 LLM 直接查好价」：只有优惠/好价信号句才拦；
 *  纯「查询/搜索商品」按用户口径不限定好价，交 LLM 走站内真搜索。 */
describe('detectDealsCommand', () => {
  it.each([
    '今天有什么打折的',
    '帮我找找优惠',
    '有折扣吗',
    '最近有什么好价',
    '便宜的东西',
    '有没有特价商品',
    '有什么便宜的',
    '推荐点划算的',
    '查一下好价',
    '便宜的货',
    '今天有没有秒杀',
  ])('好价信号句直连：%s', (text) => {
    expect(detectDealsCommand(text)).toBe(true)
  })

  it.each([
    // 纯商品查询/泛词：不再限定好价，交 LLM 调工具走站内真搜索
    '查询商品',
    '搜索商品',
    '有什么东西推荐',
    '有什么买卖',
    '把东西拿过来',
    '这商品怎么样',
    '买卖不成仁义在',
    '今天天气怎么样',
    '播放周杰伦的稻香',
    '音量30%',
    '忘了我的作息',
    // 带具体商品名的查询：交给 LLM 提取 keyword 调工具，不在此拦
    '查一下耳机多少钱',
    '',
  ])('纯商品查询 / 泛词 / 其它命令不直连：%s', (text) => {
    expect(detectDealsCommand(text)).toBe(false)
  })
})
