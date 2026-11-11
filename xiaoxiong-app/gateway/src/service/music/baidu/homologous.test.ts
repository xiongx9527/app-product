import { describe, it, expect } from 'vitest'
import { createBaiduMusicSource } from './index'
import type { MusicFetcher } from '../types'

const SEARCH_HTML = '<a href="/music/4198" title="一路向北 - 周杰伦"></a>'
const DETAIL_HTML =
  '<div id="content-lrc">[00:00.81]一路向北 - 周杰伦<br/>[00:37.39]后视镜里的世界<br/>[00:44.54]越来越远的道别</div>' +
  "<script>window.appData = JSON.parse('{\"play_id\":\"TOKEN\",\"mp3_cover\":\"https://img/cover.jpg\",\"lrc_is_empty\":false}');</script>"

/** 桩 fetcher：只模拟歌曲宝的搜索页 / 详情页 / common-play-url，其余请求一律失败（防真实触网）。 */
function mockFetcher(opts?: { search?: () => string; onSearch?: () => void }): MusicFetcher {
  return (url: string) => {
    let body: unknown = ''
    let ok = true
    if (url.includes('/s/')) {
      opts?.onSearch?.()
      body = opts?.search ? opts.search() : SEARCH_HTML
    } else if (url.includes('/member/common-play-url')) {
      body = { code: 1, data: { url: 'https://kw/x.mp3' } }
    } else if (url.includes('/music/')) {
      body = DETAIL_HTML
    } else {
      ok = false
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      json: async () => body,
      text: async () => text,
    } as unknown as Response)
  }
}

describe('百度源：音频与字幕必须同源同曲', () => {
  it('歌曲宝命中：resolve 返回同源封面，getSubtitle 直接给同一详情页的歌词（零二次检索）', async () => {
    let searches = 0
    const source = createBaiduMusicSource(mockFetcher({ onSearch: () => { searches++ } }))
    const track = await source.resolve('周杰伦 一路向北')
    expect(track.channel).toBe('gequbao')
    expect(track.cover).toBe('https://img/cover.jpg')
    const afterResolve = searches
    // 自动字幕用 track.title + 空歌手；joinArtistTitle 去重后正好命中 resolve 时缓存的检索词
    const lines = await source.getSubtitle!('', track.title)
    expect(lines?.[0]).toEqual({ time: 0.81, text: '一路向北 - 周杰伦' })
    expect(searches).toBe(afterResolve) // 命中同源缓存，播放后不再发搜索请求
  })

  it('显式字幕问的是别的歌：缓存未命中时只在歌曲宝内重搜，搜不到返回 null，绝不误配上一首的词', async () => {
    let searchCount = 0
    const source = createBaiduMusicSource(
      mockFetcher({ search: () => (++searchCount === 1 ? SEARCH_HTML : '<div>no results</div>') }),
    )
    await source.resolve('周杰伦 一路向北') // 第一次搜索命中
    const lines = await source.getSubtitle!('林俊杰', '江南') // 第二次搜索扑空
    expect(lines).toBeNull()
  })

  it('电台（风格）请求无字幕：getSubtitle 返回 null，不跨源去配歌词', async () => {
    const source = createBaiduMusicSource(mockFetcher({ search: () => '<div>no results</div>' }))
    const track = await source.resolve('放点爵士')
    expect(track.url).toContain('somafm.com')
    expect(await source.getSubtitle!('周杰伦', '一路向北')).toBeNull()
  })
})
