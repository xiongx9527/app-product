import { describe, it, expect } from 'vitest'
import type { MusicFetcher } from '../types'
import { getGequbaoLyrics, getGequbaoAudioUrl, resolveGequbaoTrack, normalizeCoverUrl, extractLrc, extractPlayId, extractAppData, extractLrcIsEmpty } from './gequbao'

const SEARCH_HTML =
  '<a href="/music/4198" title="一路向北 - 周杰伦">x</a>' +
  '<a href="/music/9999" title="一路向北 - 别人">y</a>'
const DETAIL_LRC =
  '<div id="content-lrc">[00:00.81]一路向北 - 周杰伦<br/>[00:37.39]后视镜里的世界<br/>[00:44.54]越来越远的道别</div>' +
  "<script>window.appData = JSON.parse('{\"mp3_id\":4198,\"play_id\":\"PLAYTOKEN\",\"mp3_cover\":\"https://img/cover.jpg\",\"lrc_is_empty\":false}');</script>"
const DETAIL_NO_LRC =
  '<div id="content-lrc"></div>' +
  "<script>window.appData = JSON.parse('{\"mp3_id\":4198,\"play_id\":\"PLAYTOKEN\",\"lrc_is_empty\":true}');</script>"
const DETAIL_NO_PLAY = '<div id="content-lrc">[00:00.81]x</div>'

function mockFetcher(opts: { search: string | ((url: string) => string); detail?: (id: string) => string; playUrl?: string }): MusicFetcher {
  return (url: string) => {
    let body: unknown
    let ok = true
    if (url.includes('/s/')) body = typeof opts.search === 'function' ? opts.search(url) : opts.search
    else if (url.includes('/member/common-play-url')) body = { code: 1, data: { url: opts.playUrl ?? '' } }
    else if (url.includes('/music/')) {
      const id = url.match(/\/music\/(\d+)/)?.[1] ?? ''
      body = opts.detail?.(id) ?? ''
    } else {
      body = ''
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

describe('extractLrc / extractPlayId', () => {
  it('extractLrc 抠出带时间轴的 LRC 文本', () => {
    const html = '<div id="content-lrc">[00:01.00]a<br/>[00:02.00]b</div>'
    expect(extractLrc(html)).toContain('[00:01.00]a')
    expect(extractLrc(html)).toContain('[00:02.00]b')
  })

  it('extractPlayId 解析 appData 里的 play_id（含 \\u0022 转义）', () => {
    const html = "window.appData = JSON.parse('{\\u0022mp3_id\\u0022:4198,\\u0022play_id\\u0022:\\\"P\\\"}');"
    expect(extractPlayId(html)).toBe('P')
  })

  it('extractPlayId 缺 appData 时返回 null', () => {
    expect(extractPlayId('<div>no appData</div>')).toBeNull()
  })

  it('extractAppData 解析出 play_id、mp3_cover 与 lrc_is_empty', () => {
    const html = "<script>window.appData = JSON.parse('{\"play_id\":\"P\",\"mp3_cover\":\"https://img/c.jpg\",\"lrc_is_empty\":false}');</script>"
    expect(extractAppData(html)).toEqual({ play_id: 'P', mp3_cover: 'https://img/c.jpg', lrc_is_empty: false })
  })

  it('extractLrcIsEmpty 按 appData.lrc_is_empty 判定（与下载歌词按钮同信号）', () => {
    const empty = "<script>window.appData = JSON.parse('{\"lrc_is_empty\":true}');</script>"
    const has = "<script>window.appData = JSON.parse('{\"lrc_is_empty\":false}');</script>"
    expect(extractLrcIsEmpty(empty)).toBe(true)
    expect(extractLrcIsEmpty(has)).toBe(false)
    expect(extractLrcIsEmpty('<div>no appData</div>')).toBe(false)
  })
})

describe('getGequbaoLyrics', () => {
  it('歌手+歌名匹配且有时间轴 LRC：返回带时间的行', async () => {
    const fetcher = mockFetcher({ search: SEARCH_HTML, detail: () => DETAIL_LRC, playUrl: 'https://kw.mp3/x' })
    const lines = await getGequbaoLyrics('周杰伦', '一路向北', fetcher)
    expect(lines).not.toBeNull()
    expect(lines?.[0]).toEqual({ time: 0.81, text: '一路向北 - 周杰伦' })
    expect(lines?.[1].text).toBe('后视镜里的世界')
  })

  it('排序：歌手匹配优先（周杰伦排到别人前，且拿到其歌词）', async () => {
    const fetcher = mockFetcher({
      // 别人 在前、周杰伦 在后，但应排序后先试周杰伦
      search: '<a href="/music/9999" title="一路向北 - 别人"></a><a href="/music/4198" title="一路向北 - 周杰伦"></a>',
      detail: (id) => (id === '4198' ? DETAIL_LRC : DETAIL_NO_LRC),
      playUrl: 'https://kw.mp3/x',
    })
    const lines = await getGequbaoLyrics('周杰伦', '一路向北', fetcher)
    expect(lines?.length).toBeGreaterThan(0)
  })

  it('搜索无候选：返回 null', async () => {
    const fetcher = mockFetcher({ search: '<div>no results</div>' })
    expect(await getGequbaoLyrics('歌手', '歌', fetcher)).toBeNull()
  })

  it('查询带「的」（如「周杰伦的一路向北」）扑空时，按变体去掉「的」仍能拿到歌词', async () => {
    // 带「的」的搜索词返回空结果（模拟歌曲宝对口语化查询扑空），变体「一路向北」命中
    const fetcher = mockFetcher({
      search: (url) => (url.includes('%E7%9A%84') ? '<div>no results</div>' : SEARCH_HTML),
      detail: () => DETAIL_LRC,
      playUrl: 'https://kw.mp3/x',
    })
    const lines = await getGequbaoLyrics('', '周杰伦的一路向北', fetcher)
    expect(lines?.length).toBeGreaterThan(0)
  })

  it('候选详情无 LRC：返回 null', async () => {
    const fetcher = mockFetcher({ search: SEARCH_HTML, detail: () => DETAIL_NO_LRC })
    expect(await getGequbaoLyrics('周杰伦', '一路向北', fetcher)).toBeNull()
  })
})

describe('getGequbaoAudioUrl', () => {
  it('play_id 回传 common-play-url 返回直链 MP3', async () => {
    const fetcher = mockFetcher({
      search: SEARCH_HTML,
      detail: () => DETAIL_LRC,
      playUrl: 'https://kw-er.kuwo.cn/abc.mp3?bitrate$128&from=vip',
    })
    expect(await getGequbaoAudioUrl('一路向北', fetcher)).toBe('https://kw-er.kuwo.cn/abc.mp3?bitrate$128&from=vip')
  })

  it('详情无 play_id：返回 null（回退 B 站）', async () => {
    const fetcher = mockFetcher({ search: SEARCH_HTML, detail: () => DETAIL_NO_PLAY })
    expect(await getGequbaoAudioUrl('一路向北', fetcher)).toBeNull()
  })

  it('搜索无候选：返回 null', async () => {
    const fetcher = mockFetcher({ search: '<div>no results</div>' })
    expect(await getGequbaoAudioUrl('歌', fetcher)).toBeNull()
  })

  it('查询带「的」扑空时，按变体仍可拿到音频直链', async () => {
    const fetcher = mockFetcher({
      search: (url) => (url.includes('%E7%9A%84') ? '<div>no results</div>' : SEARCH_HTML),
      detail: () => DETAIL_LRC,
      playUrl: 'https://kw-er.kuwo.cn/abc.mp3?bitrate$128&from=vip',
    })
    expect(await getGequbaoAudioUrl('周杰伦的一路向北', fetcher)).toBe(
      'https://kw-er.kuwo.cn/abc.mp3?bitrate$128&from=vip',
    )
  })
})

describe('resolveGequbaoTrack（音频 + 封面 + 字幕同源同曲）', () => {
  it('一次详情页拿全：返回音频直链、同源封面、同一详情页的 LRC', async () => {
    const fetcher = mockFetcher({ search: SEARCH_HTML, detail: () => DETAIL_LRC, playUrl: 'https://kw/x.mp3' })
    const track = await resolveGequbaoTrack('一路向北', fetcher)
    expect(track?.url).toBe('https://kw/x.mp3')
    expect(track?.cover).toBe('https://img/cover.jpg')
    expect(track?.lyrics[0]).toEqual({ time: 0.81, text: '一路向北 - 周杰伦' })
  })

  it('lrc_is_empty=true：仍返回音频，但 lyrics 为空数组（同源但无字幕，客户端显示「暂无字幕」）', async () => {
    const fetcher = mockFetcher({ search: SEARCH_HTML, detail: () => DETAIL_NO_LRC, playUrl: 'https://kw/x.mp3' })
    const track = await resolveGequbaoTrack('一路向北', fetcher)
    expect(track?.url).toBe('https://kw/x.mp3')
    expect(track?.lyrics).toEqual([])
  })

  it('详情页无 play_id：返回 null（回退 B 站）', async () => {
    const fetcher = mockFetcher({ search: SEARCH_HTML, detail: () => DETAIL_NO_PLAY })
    expect(await resolveGequbaoTrack('一路向北', fetcher)).toBeNull()
  })
})

describe('normalizeCoverUrl（封面可显示的关键）', () => {
  it('清掉 appData 里 \\/ 转义残留、把 http 明文升为 https', () => {
    // 实测歌曲宝返回的 mp3_cover 形如 http:\/\/img1.kuwo.cn\/star\/...（非法 URL + 明文，App 端加载不出）
    expect(normalizeCoverUrl('http:\\/\\/img1.kuwo.cn\\/star\\/albumcover\\/cover.jpg')).toBe(
      'https://img1.kuwo.cn/star/albumcover/cover.jpg',
    )
  })

  it('协议相对 // 补 https；已是 https 原样保留', () => {
    expect(normalizeCoverUrl('//img.kuwo.cn/c.jpg')).toBe('https://img.kuwo.cn/c.jpg')
    expect(normalizeCoverUrl('https://img.kuwo.cn/c.jpg')).toBe('https://img.kuwo.cn/c.jpg')
  })

  it('空值返回 undefined', () => {
    expect(normalizeCoverUrl(undefined)).toBeUndefined()
    expect(normalizeCoverUrl('')).toBeUndefined()
  })
})
