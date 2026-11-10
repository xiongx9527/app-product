import { describe, it, expect } from 'vitest'
import type { MusicFetcher } from '../types'
import { getKugouLyrics } from './kugouLyrics'

const LRC = '[00:01.00]第一句\n[00:05.50]第二句\n[00:09.00]第三句'

/** 用给定的搜索候选与（base64 编码的）歌词构造一个 MusicFetcher mock。 */
function mockFetcher(cands: unknown, lyricBase64: string): MusicFetcher {
  return (url: string) => {
    const body =
      url.includes('/search')
        ? { status: 200, candidates: cands }
        : { status: 200, content: lyricBase64, fmt: 'lrc' }
    return Promise.resolve({
      ok: true,
      json: async () => body,
    } as unknown as Response)
  }
}

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64')
}

describe('getKugouLyrics', () => {
  it('检索命中正版候选并解析 LRC 为带时间行', async () => {
    const fetcher = mockFetcher(
      [{ id: '1', accesskey: 'ak1', singer: '周杰伦', song: '一路向北', score: 60 }],
      b64(LRC)
    )
    const lines = await getKugouLyrics('周杰伦', '一路向北', fetcher)
    expect(lines).not.toBeNull()
    expect(lines).toEqual([
      { time: 1, text: '第一句' },
      { time: 5.5, text: '第二句' },
      { time: 9, text: '第三句' },
    ])
  })

  it('一行多时间标签：拆成多行，时间与文本一致', async () => {
    const fetcher = mockFetcher(
      [{ id: '2', accesskey: 'ak2', singer: '五月天', song: '温柔', score: 60 }],
      b64('[00:02.00][00:30.00]同一句')
    )
    const lines = await getKugouLyrics('五月天', '温柔', fetcher)
    expect(lines).toEqual([
      { time: 2, text: '同一句' },
      { time: 30, text: '同一句' },
    ])
  })

  it('歌手不匹配：指定歌手时只在歌手命中候选里挑，否则返回 null', async () => {
    // 候选歌手是「李风风」而非「周杰伦」，pickBest 不命中 → 返回 null（不拿错人的词）。
    const fetcher = mockFetcher(
      [{ id: '9', accesskey: 'ak9', singer: '李风风', song: '一路向北', score: 60 }],
      b64(LRC)
    )
    const lines = await getKugouLyrics('周杰伦', '一路向北', fetcher)
    expect(lines).toBeNull()
  })

  it('搜索无候选：返回 null', async () => {
    const fetcher = mockFetcher([], b64(LRC))
    const lines = await getKugouLyrics('歌手', '歌', fetcher)
    expect(lines).toBeNull()
  })

  it('下载内容为空：返回 null', async () => {
    const fetcher = mockFetcher(
      [{ id: '3', accesskey: 'ak3', singer: '歌手', song: '歌', score: 60 }],
      ''
    )
    const lines = await getKugouLyrics('歌手', '歌', fetcher)
    expect(lines).toBeNull()
  })
})
