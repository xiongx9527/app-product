import { describe, it, expect } from 'vitest'
import { detectBaikeCommand } from './baikeControl'

describe('detectBaikeCommand', () => {
  it.each([
    ['百科李存勖', '李存勖'],
    ['百度百科李存勖', '李存勖'],
    ['查一下李存勖的百科', '李存勖'],
    ['李存勖的百科', '李存勖'],
    ['科普一下人工智能百科', '人工智能'],
    ['李存勖的事迹', '李存勖'],
    ['讲讲李存勖事迹', '李存勖'],
    ['李存勖人物传', '李存勖'],
    ['李存勖的人物传记', '李存勖'],
    ['人物介绍李存勖', '李存勖'],
    ['李存勖的人物介绍', '李存勖'],
    ['李存勖生平', '李存勖'],
    ['李存勖人物生平', '李存勖'],
    ['讲讲李存勖的人物生平', '李存勖'],
    ['安史之乱历史事件', '安史之乱'],
    ['讲讲靖康之变的历史事件', '靖康之变'],
    ['介绍下李存勖', '李存勖'],
    ['介绍一下李存勖', '李存勖'],
    ['介绍下“李存勖”', '李存勖'],
    ['讲讲李存勖', '李存勖'],
    ['说说人工智能', '人工智能'],
    ['wiki Einstein', 'Einstein'],
    ['encyclopedia人工智能', '人工智能'],
  ])('带话题命中：%s → %s', (text, keyword) => {
    expect(detectBaikeCommand(text)?.keyword).toBe(keyword)
  })

  it.each(['百科', '查百科', '百度百科', '人物传记', '事迹', '生平', '历史事件', 'wiki'])('无话题：%s → null keyword', (text) => {
    expect(detectBaikeCommand(text)).toEqual({ keyword: null })
  })

  it.each([
    '今天天气怎么样',
    '播放新闻',
    '播放一首歌',
    '李存勖是谁', // 泛问法交回 LLM
    '什么是人工智能', // 泛问法交回 LLM
    '介绍下', // 无话题词，不算
  ])('非百科意图不命中：%s', (text) => {
    expect(detectBaikeCommand(text)).toBeNull()
  })

  it('其它内容强特征优先：百科里混歌曲/新闻词不误抢', () => {
    expect(detectBaikeCommand('播放百科里的主题曲')).toBeNull()
    expect(detectBaikeCommand('百科新闻')).toBeNull()
  })
})
