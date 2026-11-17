import { describe, it, expect } from 'vitest'
import { detectNewsCommand, detectNewsNextCommand } from './newsControl'

describe('detectNewsCommand', () => {
  // 泛播：命中但无话题词
  it.each([
    '播放新闻',
    '新闻',
    '最新消息',
    '今天的新闻',
    '今天有什么新闻',
    '播报一下新闻',
    '头条',
    '有什么热点',
    '看看快讯',
    '播放资讯',
    '资讯',
    'NEWS',
    'headlines',
  ])('泛播命中：%s', (text) => {
    expect(detectNewsCommand(text)).toEqual({ keyword: null })
  })

  // 带话题：提取触发词前片段
  it.each([
    ['科技新闻', '科技'],
    ['科技最新消息', '科技'],
    ['关于科技的新闻', '关于科技'],
    ['播放体育新闻', '体育'],
    ['财经头条', '财经'],
    ['来点汽车的消息', '汽车'],
    ['科技资讯', '科技'], // 「资讯」与新闻同义
    ['财经资讯', '财经'],
    ['再放个科技新闻', '科技'], // 「再」被剥掉，视为全新请求
  ])('带话题命中：%s → %s', (text, keyword) => {
    expect(detectNewsCommand(text)).toEqual({ keyword })
  })

  // 反例：非新闻意图，交回下游
  it.each([
    '',
    '   ',
    '播放周杰伦的稻香',
    '今天天气怎么样',
    '音量调到30%',
    '查询商品',
    '看个电影',
    '来段评书',
    '听一首歌',
  ])('不命中：%s', (text) => {
    expect(detectNewsCommand(text)).toBeNull()
  })

  it('其它内容强特征优先于新闻词，不误抢', () => {
    expect(detectNewsCommand('播放新闻歌曲')).toBeNull()
    expect(detectNewsCommand('新闻里的那首歌')).toBeNull()
    expect(detectNewsCommand('播放资讯歌曲')).toBeNull()
  })
})

describe('detectNewsNextCommand（新闻播放中的切条）', () => {
  it.each([
    '下一条',
    '播放下一条',
    '放一下下一条',
    '换一条',
    '换条新闻',
    '换个资讯',
    '再来一条',
    '再放一条',
    '下一条新闻',
  ])('命中：%s', (text) => {
    expect(detectNewsNextCommand(text)).toBe(true)
  })

  it.each([
    '',
    '   ',
    '播放新闻',
    '播放资讯',
    '下一首', // 音乐的换歌指令，不能抢
    '换一首',
    '下一段评书', // 其它内容词，交回音乐
    '今天天气怎么样',
    '第二条', // 选号，由 parseSelection 处理
  ])('不命中：%s', (text) => {
    expect(detectNewsNextCommand(text)).toBe(false)
  })
})
