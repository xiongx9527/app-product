import { describe, it, expect } from 'vitest'
import type { MusicFetcher } from '../types'
import { getNeteaseLyrics } from './neteaseLyrics'

/** 用给定的搜索/歌词响应构造一个 MusicFetcher mock。 */
function mockFetcher(searchSongs: unknown, lyricRaw: string): MusicFetcher {
  return (url: string) => {
    const body =
      url.includes('/api/search/get')
        ? { result: { songs: searchSongs } }
        : { code: 200, lrc: { lyric: lyricRaw } }
    return Promise.resolve({
      ok: true,
      json: async () => body,
    } as unknown as Response)
  }
}

const LRC = '[00:01.00]第一句\n[00:05.50]第二句\n[00:09.00]第三句'

describe('getNeteaseLyrics', () => {
  it('检索命中正版候选并解析 LRC 为带时间行', async () => {
    const fetcher = mockFetcher(
      [{ id: 1, name: '稻香', artists: [{ name: '周杰伦' }] }],
      LRC
    )
    const lines = await getNeteaseLyrics('周杰伦', '稻香', fetcher)
    expect(lines).not.toBeNull()
    expect(lines).toEqual([
      { time: 1, text: '第一句' },
      { time: 5.5, text: '第二句' },
      { time: 9, text: '第三句' },
    ])
  })

  it('一行多时间标签：拆成多行，时间与文本一致', async () => {
    const fetcher = mockFetcher(
      [{ id: 2, name: '晴天', artists: [{ name: '周杰伦' }] }],
      '[00:02.00][00:30.00]同一句'
    )
    const lines = await getNeteaseLyrics('周杰伦', '晴天', fetcher)
    expect(lines).toEqual([
      { time: 2, text: '同一句' },
      { time: 30, text: '同一句' },
    ])
  })

  it('网易云曲库受限（如周杰伦 一路向北）：搜不到正版返回 null', async () => {
    // 搜索结果只有翻唱/cover，歌手不含周杰伦，pickBest 不命中
    const fetcher = mockFetcher(
      [{ id: 9, name: '一路向北', artists: [{ name: '李风风' }] }],
      LRC
    )
    const lines = await getNeteaseLyrics('周杰伦', '一路向北', fetcher)
    expect(lines).toBeNull()
  })

  it('歌词为「暂无歌词」占位：返回 null', async () => {
    const fetcher = mockFetcher(
      [{ id: 3, name: '歌', artists: [{ name: '歌手' }] }],
      '暂无歌词'
    )
    const lines = await getNeteaseLyrics('歌手', '歌', fetcher)
    expect(lines).toBeNull()
  })

  it('搜索无结果：返回 null', async () => {
    const fetcher = mockFetcher([], LRC)
    const lines = await getNeteaseLyrics('歌手', '歌', fetcher)
    expect(lines).toBeNull()
  })
})
