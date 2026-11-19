import { describe, it, expect } from 'vitest'
import { createPoemTool, POEM_TOOL_NAME } from '../../../src/service/tools/poemTool'
import type { MediaDirective } from '../../../src/service/tools/musicTool'
import type { EduFetcher } from '../../../src/service/edu'

const DETAIL_JSON = JSON.stringify({
  errno: 0,
  data: {
    name: '岳阳楼记',
    author: '范仲淹',
    dynasty: '宋',
    voiceInfo: { url: 'https://hanyu-poem-mp3.cdn.bcebos.com/abc.mp3' },
    poemLines: [{ source: '庆历四年春', punc: '，' }, { source: '滕子京谪守巴陵郡', punc: '。' }],
  },
})

function fetcherWithSid(): EduFetcher {
  return (async (url: string) => ({
    ok: true,
    text: async () =>
      url.includes('/s?wd=')
        ? '<a href="https://hanyu.baidu.com/shici/detail?pid=88a995b2cee5470a9e75a09209b3f51c">x</a>'
        : DETAIL_JSON,
  })) as EduFetcher
}

describe('createPoemTool', () => {
  it('工具名固定', () => {
    expect(createPoemTool('zh-CN').name).toBe(POEM_TOOL_NAME)
  })

  it('查到诗词：下发 media.subtitle + media.play(source:tts)，返回简短引导（不含全文）', async () => {
    const events: MediaDirective[] = []
    const tool = createPoemTool('zh-CN', {
      fetcher: fetcherWithSid(),
      emit: (m) => events.push(m),
    })
    const out = (await tool.call({ query: '岳阳楼记' })) as string
    const subs = events.filter((e) => e.type === 'media.subtitle') as Array<{ title: string; lines: unknown[] }>
    const plays = events.filter((e) => e.type === 'media.play') as Array<{ url: string; source?: string }>
    expect(subs).toHaveLength(1)
    expect(subs[0].title).toBe('岳阳楼记')
    expect(subs[0].lines).toHaveLength(2)
    expect(plays).toHaveLength(1)
    expect(plays[0].url).toContain('mp3')
    expect(plays[0].source).toBe('tts')
    expect(out).toContain('岳阳楼记')
    expect(out).not.toContain('庆历四年春') // 原文不进 LLM 回复
  })

  it('查不到：诚实返回没找到，不下发任何媒体事件', async () => {
    const events: MediaDirective[] = []
    const tool = createPoemTool('zh-CN', {
      fetcher: (async () => ({ ok: true, text: async () => '<html>无卡片</html>' })) as EduFetcher,
      emit: (m) => events.push(m),
    })
    const out = (await tool.call({ query: '未知' })) as string
    expect(out).toContain('没查到')
    expect(events).toHaveLength(0)
  })
})
