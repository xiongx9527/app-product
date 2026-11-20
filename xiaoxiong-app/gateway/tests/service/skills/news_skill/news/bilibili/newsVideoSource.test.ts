import { describe, expect, it, vi } from 'vitest'
import { cleanNewsTitle, createNewsVideoSource } from '../../../../../../src/service/skills/news_skill/news/bilibili/newsVideoSource'
import type { MusicFetcher } from '../../../../../../src/service/skills/music_skill/music/types'

describe('cleanNewsTitle 标题清洗', () => {
  it('去掉下划线、特殊括号、竖线与 emoji', () => {
    expect(cleanNewsTitle('三分钟_了解【今日】新闻联播🔥｜快讯')).toBe('三分钟 了解 今日 新闻联播 快讯')
  })

  it('去掉 HTML 高亮标签与 markdown 符号', () => {
    expect(cleanNewsTitle('<em>科技</em>_新闻 #头条 `快讯`')).toBe('科技 新闻 头条 快讯')
  })

  it('折叠多余空白', () => {
    expect(cleanNewsTitle('  今日   新闻  \n 联播 ')).toBe('今日 新闻 联播')
  })

  it('清洗后为空则回退到去空白的原文', () => {
    expect(cleanNewsTitle('___')).toBe('___')
  })
})

/** 构造一个假 fetcher：nav 拿 wbi key，search 返回视频列表，view/playurl 给音轨。 */
function fakeFetcher(hits: Array<{ bvid: string; title: string }>, audioUrl = 'https://x.bilivideo.com/a.m4s'): MusicFetcher {
  return vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/nav')) {
      return { ok: true, json: async () => ({ data: { wbi_img: { img_url: 'https://x/i.png', sub_url: 'https://x/s.png' } } }) } as never
    }
    if (u.includes('/search')) {
      return { ok: true, json: async () => ({ data: { result: hits.map((h) => ({ bvid: h.bvid, title: h.title })) } }) } as never
    }
    if (u.includes('/view')) {
      return { ok: true, json: async () => ({ code: 0, data: { cid: 123, title: '解析出的标题' } }) } as never
    }
    if (u.includes('/playurl')) {
      return { ok: true, json: async () => ({ code: 0, data: { dash: { audio: [{ baseUrl: audioUrl, bandwidth: 128000 }] } } }) } as never
    }
    return { ok: false, json: async () => ({}) } as never
  }) as MusicFetcher
}

describe('newsVideoSource 新闻视频音源', () => {
  it('泛播用「今日新闻」搜候选，标题已清洗', async () => {
    const fetcher = fakeFetcher([{ bvid: 'BV1', title: '三分钟_了解【今日】新闻联播🔥' }])
    const src = createNewsVideoSource({ fetcher })
    const hits = await src.search(null)
    expect(hits.length).toBe(1)
    expect(hits[0].bvid).toBe('BV1')
    expect(hits[0].title).not.toMatch(/[_【】🔥]/)
  })

  it('带话题词时搜索「话题 新闻」', () => {
    const src = createNewsVideoSource({ fetcher: fakeFetcher([]) })
    expect(src.searchKeyword('科技')).toBe('科技 新闻')
    expect(src.searchKeyword(null)).toBe('今日新闻')
  })

  it('resolveBvid 抽出音轨并清洗标题；失败返回 null', async () => {
    const src = createNewsVideoSource({ fetcher: fakeFetcher([{ bvid: 'BV1', title: '新闻1' }]) })
    const video = await src.resolveBvid({ bvid: 'BV1', title: '新闻1' })
    expect(video?.url).toContain('.m4s')
    expect(video?.bvid).toBe('BV1')

    const bad = createNewsVideoSource({
      fetcher: (() => Promise.resolve({ ok: true, json: async () => ({ code: -404 }) } as never)) as MusicFetcher,
    })
    expect(await bad.resolveBvid({ bvid: 'BVX', title: 'x' })).toBeNull()
  })
})
