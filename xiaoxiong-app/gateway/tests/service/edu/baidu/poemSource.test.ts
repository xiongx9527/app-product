import { describe, it, expect, vi } from 'vitest'
import {
  extractPoemSid,
  parsePoemDetail,
  queryPoem,
  type EduFetcher,
} from '../../../../src/service/edu/baidu/poemSource'

const DETAIL_JSON = JSON.stringify({
  errno: 0,
  data: {
    name: '岳阳楼记',
    author: '范仲淹',
    dynasty: '宋',
    voiceInfo: { url: 'http://hanyu-poem-mp3.cdn.bcebos.com/abc.mp3' },
    poemLines: [
      { source: '庆历四年春', punc: '，' },
      { source: '滕子京谪守巴陵郡', punc: '。' },
    ],
  },
})

describe('extractPoemSid', () => {
  it('从 shici/detail?pid 提取 sid', () => {
    const html = '<a href="https://hanyu.baidu.com/shici/detail?pid=88a995b2cee5470a9e75a09209b3f51c">x</a>'
    expect(extractPoemSid(html)).toBe('88a995b2cee5470a9e75a09209b3f51c')
  })

  it('pid 前面还有其它参数时也能提取（滕王阁序 ?from=aladdin&pid=）', () => {
    const html = '<a href="https://hanyu.baidu.com/shici/detail?from=aladdin&pid=812645dae8cc493b89434f272f92a315&smp_names=termBr">x</a>'
    expect(extractPoemSid(html)).toBe('812645dae8cc493b89434f272f92a315')
  })

  it('HTML 转义的 &amp;pid 也能提取', () => {
    const html = 'href="https://hanyu.baidu.com/shici/detail?from=aladdin&amp;pid=812645dae8cc493b89434f272f92a315"'
    expect(extractPoemSid(html)).toBe('812645dae8cc493b89434f272f92a315')
  })

  it('从 poem-voice mp3 提取 sid', () => {
    const html = 'https://hanyu-poem-voice.cdn.bcebos.com/man/812645dae8cc493b89434f272f92a315.mp3'
    expect(extractPoemSid(html)).toBe('812645dae8cc493b89434f272f92a315')
  })

  it('poem-mp3 无 man/ 段的直链也能提取', () => {
    const html = 'http://hanyu-poem-mp3.cdn.bcebos.com/812645dae8cc493b89434f272f92a315.mp3'
    expect(extractPoemSid(html)).toBe('812645dae8cc493b89434f272f92a315')
  })

  it('无 aladdin 卡片返回 null', () => {
    expect(extractPoemSid('<html>无关内容</html>')).toBeNull()
  })
})

describe('parsePoemDetail', () => {
  it('解析原文/作者/mp3，http 音频转 https', () => {
    const entry = parsePoemDetail(DETAIL_JSON, 'sid1', '兜底名')
    expect(entry?.title).toBe('岳阳楼记')
    expect(entry?.author).toBe('范仲淹')
    expect(entry?.lines).toEqual(['庆历四年春，', '滕子京谪守巴陵郡。'])
    expect(entry?.audioUrl).toBe('https://hanyu-poem-mp3.cdn.bcebos.com/abc.mp3')
  })

  it('errno≠0 返回 null', () => {
    expect(parsePoemDetail('{"errno":1}', 'sid', 'x')).toBeNull()
  })
})

describe('queryPoem', () => {
  it('搜索页提 sid → 详情 API → 返回词条', async () => {
    const fetcher = vi.fn(async (url: string) => ({
      ok: true,
      text: async () =>
        url.includes('/s?wd=')
          ? '<a href="https://hanyu.baidu.com/shici/detail?pid=88a995b2cee5470a9e75a09209b3f51c">x</a>'
          : DETAIL_JSON,
    })) as unknown as EduFetcher
    const entry = await queryPoem('岳阳楼记', fetcher)
    expect(entry?.title).toBe('岳阳楼记')
    expect(entry?.lines.length).toBe(2)
  })

  it('搜索页无 sid → 返回 null（诚实回退）', async () => {
    const fetcher = (async () => ({ ok: true, text: async () => '<html>无卡片</html>' })) as EduFetcher
    expect(await queryPoem('未知作品', fetcher)).toBeNull()
  })
})
