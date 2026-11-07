import { describe, it, expect } from 'vitest'
import { createSomaSource } from './somaSource'
import { createBaiduSource, titleMatchesKeyword } from './baiduSource'
import { extractBvidsFromHtml } from './bilibiliAudio'
import { createMusicSource } from './index'
import { SOMA_CHANNELS } from '../tools/musicChannels'
import type { MusicFetcher } from './types'
import { isGenreRequest, genreToKeyword } from './types'

describe('music sources', () => {
  it('soma：无风格时用默认频道', async () => {
    const source = createSomaSource({})
    const track = await source.resolve()
    expect(track.url).toContain(track.channel)
  })

  it('soma：按风格选台（爵士 → sonicuniverse）', async () => {
    const source = createSomaSource({})
    const track = await source.resolve('放点爵士')
    expect(track.channel).toBe('sonicuniverse')
  })

  it('soma：频道表 id 唯一且都指向 ice6 直链', async () => {
    const ids = SOMA_CHANNELS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const channel of SOMA_CHANNELS) {
      expect(channel.url).toBe(`https://ice6.somafm.com/${channel.id}-128-mp3`)
    }
  })

  it('soma：next 切换到一个不同的频道', async () => {
    const source = createSomaSource({ station: 'groovesalad' })
    const first = await source.resolve()
    const second = await source.next!()
    expect(second.channel).not.toBe(first.channel)
    expect(second.url).toContain(second.channel)
  })
})

describe('genre 分流', () => {
  it('isGenreRequest：风格词命中，具体歌名不命中', () => {
    expect(isGenreRequest('放点轻音乐')).toBe(true)
    expect(isGenreRequest('来首爵士')).toBe(true)
    expect(isGenreRequest('周杰伦 稻香')).toBe(false)
    expect(isGenreRequest(undefined)).toBe(true)
  })

  it('genreToKeyword：风格词映射，歌名剔指令词', () => {
    expect(genreToKeyword('放点电子')).toBe('电子')
    expect(genreToKeyword('我想听周杰伦的稻香')).toBe('周杰伦 稻香')
    expect(genreToKeyword('播放个周杰伦的稻香')).toBe('周杰伦 稻香')
  })

  it('genreToKeyword：泛化点歌回落轻音乐（避免拿「歌」去百度白搜报操作失败）', () => {
    for (const t of ['播放个', '播放个音乐', '给我放首歌', '放首歌', '来首歌', '放点音乐', '随便放点']) {
      expect(genreToKeyword(t)).toBe('轻音乐')
    }
    // 泛化词收敛后应判为风格请求 → 走 SomaFM 电台
    expect(isGenreRequest(genreToKeyword('播放个音乐'))).toBe(true)
  })
})

describe('百度搜索引擎兜底源', () => {
  /**
   * 构造 fetcher：按百度 pn 分页返回不同 SERP html（内含不同 BVID），
   * /link 落地到指定 url，B 站 wbi 三步按 BVID 返回不同音轨直链。
   * viewTitle 控制视频标题，便于验证「歌手、歌名要一样」的相关性校验。
   */
  function biliFetcher(
    byPage: (page: number) => string,
    linkLanding = 'https://haokan.baidu.com/v?vid=1',
    viewTitle: (bvid: string) => string = () => '周杰伦《稻香》完整版无损音质'
  ): MusicFetcher {
    return async (url) => {
      if (url.includes('baidu.com/s')) {
        const page = Number(/[?&]pn=(\d+)/.exec(url)?.[1] ?? '0') / 10
        return { ok: true, status: 200, json: async () => ({}), text: async () => byPage(page), url }
      }
      if (url.includes('/link?url=')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '', url: linkLanding }
      }
      if (url.includes('x/web-interface/nav')) {
        return {
          ok: true, status: 200,
          json: async () => ({ data: { wbi_img: { img_url: 'https://i0.hdslb.com/wbi/xxx.png', sub_url: 'https://i0.hdslb.com/wbi/yyy.png' } } }),
          text: async () => '',
        }
      }
      if (url.includes('wbi/view')) {
        const bvid = /bvid=(BV[0-9A-Za-z]+)/.exec(url)?.[1] ?? ''
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { cid: 123, title: viewTitle(bvid) } }), text: async () => '' }
      }
      expect(url).toContain('wbi/playurl')
      const bvid = /bvid=(BV[0-9A-Za-z]+)/.exec(url)?.[1] ?? 'unknown'
      return {
        ok: true, status: 200,
        json: async () => ({ code: 0, data: { dash: { audio: [{ bandwidth: 1, baseUrl: `https://bili/${bvid}.m4s` }] } } }),
        text: async () => '',
      }
    }
  }

  const page0Html = (bvid: string) => `<div mu="https://www.bilibili.com/video/${bvid}/">稻香</div>`

  it('优先取 SERP 里 mu= 内嵌的 B 站直链抽音轨（真实百度结构）', async () => {
    const html = page0Html('BV1jk3z6TEgo') + '<a href="/link?url=abc">好看视频</a>'
    const track = await createBaiduSource({}, biliFetcher(() => html)).resolve('稻香')
    expect(track.url).toBe('https://bili/BV1jk3z6TEgo.m4s')
    expect(track.channel).toBe('bilibili')
    expect(track.title).toContain('稻香')
  })

  it('视频标题与歌手/歌名对不上时跳过，绝不乱播（报没找到）', async () => {
    // 百度对编造的歌名会返回低相关度视频，标题不含「周杰伦/稻香」→ 全部候选被跳过
    const html = page0Html('BV1jk3z6TEgo')
    const fetcher = biliFetcher(() => html, undefined, () => '谁说网红只会抄袭翻唱，原创歌曲出圈')
    const source = createBaiduSource({}, fetcher)
    await expect(source.resolve('周杰伦 稻香')).rejects.toThrow()
  })

  it('无内嵌 BVID 时，跟随 /link 跳转到 B 站视频页兜底', async () => {
    const html = '<a href="/link?url=abc">x</a><a href="/link?url=def">y</a>'
    const fetcher = biliFetcher(() => html, 'https://www.bilibili.com/video/BV1xx411c7mD')
    const track = await createBaiduSource({}, fetcher).resolve('稻香')
    expect(track.url).toBe('https://bili/BV1xx411c7mD.m4s')
    expect(track.channel).toBe('bilibili')
  })

  it('next() 翻到下一页拿到不同曲目（换一首不再必失败）', async () => {
    // 每页给不同 BVID：pn=0 → A，pn=10 → B
    const fetcher = biliFetcher((page) => page0Html(page === 0 ? 'BVaaaaaaaaaa' : 'BVbbbbbbbbbb'))
    const source = createBaiduSource({}, fetcher)
    const first = await source.resolve('稻香')
    const second = await source.next!('稻香')
    expect(first.url).toBe('https://bili/BVaaaaaaaaaa.m4s')
    expect(second.url).toBe('https://bili/BVbbbbbbbbbb.m4s')
    expect(first.url).not.toBe(second.url)
  })

  it('mu= 与 /link 都取不到音轨时抛错', async () => {
    // /link 落到好看视频（无 BVID），也没有内嵌 B站直链
    const html = '<a href="/link?url=abc">x</a>'
    const source = createBaiduSource({}, biliFetcher(() => html))
    await expect(source.resolve('不存在的歌')).rejects.toThrow()
  })
})

describe('titleMatchesKeyword（歌手、歌名要一样，杜绝乱播放）', () => {
  it('歌手与歌名都出现在标题里才命中', () => {
    expect(titleMatchesKeyword('周杰伦《稻香》完整版无损音质', '周杰伦 稻香')).toBe(true)
    expect(titleMatchesKeyword('【稻香】周杰伦，高清MV，治愈了整个童年', '周杰伦 稻香')).toBe(true)
  })

  it('只沾一个词、或完全不相干的视频不算命中', () => {
    expect(titleMatchesKeyword('周杰伦演唱会精选', '周杰伦 稻香')).toBe(false)
    expect(titleMatchesKeyword('谁说网红只会抄袭翻唱，原创歌曲出圈', '周杰伦 稻香')).toBe(false)
    expect(titleMatchesKeyword('随便一个音乐视频', '一首谁都没听过 稀奇古怪 歌')).toBe(false)
  })

  it('标点/书名号归一化后仍能匹配；无实词关键词不拦截（泛化已回落电台）', () => {
    expect(titleMatchesKeyword('周杰伦 - 「稻香」 Official MV', '周杰伦 稻香')).toBe(true)
    expect(titleMatchesKeyword('任意视频', '歌')).toBe(true)
  })

  it('空标题不命中', () => {
    expect(titleMatchesKeyword('', '稻香')).toBe(false)
  })
})

describe('extractBvidsFromHtml', () => {
  it('从 mu=/href 里的 B 站直链抽 BVID，去重保序', () => {
    const html =
      'mu="https://www.bilibili.com/video/BV1111111111/" ' +
      'href="https://www.bilibili.com/video/BV2222222222/?p=1" ' +
      'mu="https://www.bilibili.com/video/BV1111111111/"'
    expect(extractBvidsFromHtml(html)).toEqual(['BV1111111111', 'BV2222222222'])
  })

  it('没有 B 站链接时返回空数组', () => {
    expect(extractBvidsFromHtml('<a href="https://haokan.baidu.com/v">x</a>')).toEqual([])
  })
})

describe('音乐聚合源（无配置）', () => {
  it('始终返回可用源（不再有 undefined）', () => {
    expect(createMusicSource()).toBeTruthy()
  })

  it('风格请求走 SomaFM（离线可验证，不触网）', async () => {
    const source = createMusicSource()
    const track = await source.resolve('放点爵士')
    // channel 是 SomaFM 频道 id，url 指向 ice6 直链
    expect(track.url).toContain('somafm.com')
  })

  it('具体歌名请求走百度兜底分支（非风格）', () => {
    // isGenreRequest 已单测；这里仅确认分流方向：具体歌名不命中风格分支
    expect(isGenreRequest('周杰伦 稻香')).toBe(false)
  })
})
