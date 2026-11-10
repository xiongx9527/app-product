import { describe, it, expect } from 'vitest'
import { getBilibiliSubtitle } from './bilibiliAudio'
import type { MusicFetcher } from '../types'

/** 用预设响应构造 fetcher，便于单测字幕解析，不触网。 */
function fakeFetcher(responses: Record<string, { ok: boolean; json: () => unknown }>): MusicFetcher {
  return async (url: string) => {
    const key = Object.keys(responses).find((k) => url.includes(k)) ?? ''
    const r = responses[key]
    if (!r) return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as never
    return { ok: r.ok, status: r.ok ? 200 : 500, json: r.json, text: async () => '' } as never
  }
}

describe('getBilibiliSubtitle（同源字幕：保留每行时间轴、合并连续重复行）', () => {
  it('AI 字幕优先：保留每行起始时间，合并连续重复行', async () => {
    const fetcher = fakeFetcher({
      'x/player/wbi/v2': {
        ok: true,
        json: () => ({
          data: {
            subtitle: {
              list: [
                { lan: 'ai-subtitle', lan_doc: 'AI字幕', subtitle_url: 'https://sub.example.com/x.json' },
                { lan: 'zh-CN', lan_doc: '中文', subtitle_url: 'https://sub.example.com/y.json' },
              ],
            },
          },
        }),
      },
      'sub.example.com/x.json': {
        ok: true,
        json: () => [
          { from: 1, content: '[00:01.00]第一句' },
          { from: 5, content: '[00:05.00]第一句' },
          { from: 9, content: '[00:09.00]第二句' },
        ],
      },
    })
    const lines = await getBilibiliSubtitle('BVtest', fetcher)
    expect(lines).toEqual([
      { time: 1, text: '第一句' },
      { time: 9, text: '第二句' },
    ])
  })

  it('无 AI 字幕时回退普通字幕', async () => {
    const fetcher = fakeFetcher({
      'x/player/wbi/v2': {
        ok: true,
        json: () => ({ data: { subtitle: { list: [{ lan: 'zh-CN', subtitle_url: 'https://sub.example.com/z.json' }] } } }),
      },
      'sub.example.com/z.json': {
        ok: true,
        json: () => [{ from: 3, content: '[00:03.00]只有这一句' }],
      },
    })
    const lines = await getBilibiliSubtitle('BVtest', fetcher)
    expect(lines).toEqual([{ time: 3, text: '只有这一句' }])
  })

  it('视频自带官方歌词字段时优先用（本身就是带时间轴的纯歌词）', async () => {
    const fetcher = fakeFetcher({
      'x/player/wbi/v2': {
        ok: true,
        json: () => ({ data: { lyric: '[00:01.00]歌词A\n[00:02.00]歌词A\n[00:03.00]歌词B' } }),
      },
    })
    const lines = await getBilibiliSubtitle('BVtest', fetcher)
    expect(lines).toEqual([
      { time: 1, text: '歌词A' },
      { time: 3, text: '歌词B' },
    ])
  })

  it('没有任何字幕/歌词时返回 null', async () => {
    const fetcher = fakeFetcher({ 'x/player/wbi/v2': { ok: true, json: () => ({ data: {} }) } })
    expect(await getBilibiliSubtitle('BVtest', fetcher)).toBeNull()
  })

  it('播放接口异常时返回 null（不抛出）', async () => {
    const fetcher = fakeFetcher({})
    expect(await getBilibiliSubtitle('BVtest', fetcher)).toBeNull()
  })
})
