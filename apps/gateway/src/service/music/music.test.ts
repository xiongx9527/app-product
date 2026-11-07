import { describe, it, expect } from 'vitest'
import { createSomaSource } from './somaSource'
import { createBaiduSource } from './baiduSource'
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
  })
})

describe('百度搜索引擎兜底源', () => {
  /** 构造一个 fetcher：SERP 返回指定 html，/link 落地到指定 url，B 站 wbi 三步返回固定音轨。 */
  function biliFetcher(serpHtml: string, linkLanding = 'https://haokan.baidu.com/v?vid=1'): MusicFetcher {
    return async (url) => {
      if (url.includes('baidu.com/s')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => serpHtml, url }
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
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { cid: 123, title: '稻香' } }), text: async () => '' }
      }
      expect(url).toContain('wbi/playurl')
      return {
        ok: true, status: 200,
        json: async () => ({ code: 0, data: { dash: { audio: [{ bandwidth: 1, baseUrl: 'https://bili/audio.m4s' }] } } }),
        text: async () => '',
      }
    }
  }

  it('优先取 SERP 里 mu= 内嵌的 B 站直链抽音轨（真实百度结构）', async () => {
    const html =
      '<div mu="https://www.bilibili.com/video/BV1jk3z6TEgo/">稻香</div>' +
      '<a href="/link?url=abc">好看视频</a>'
    const track = await createBaiduSource({}, biliFetcher(html)).resolve('稻香')
    expect(track.url).toBe('https://bili/audio.m4s')
    expect(track.channel).toBe('bilibili')
    expect(track.title).toBe('稻香')
  })

  it('无内嵌 BVID 时，跟随 /link 跳转到 B 站视频页兜底', async () => {
    const html = '<a href="/link?url=abc">x</a><a href="/link?url=def">y</a>'
    const fetcher = biliFetcher(html, 'https://www.bilibili.com/video/BV1xx411c7mD')
    const track = await createBaiduSource({}, fetcher).resolve('稻香')
    expect(track.url).toBe('https://bili/audio.m4s')
    expect(track.channel).toBe('bilibili')
  })

  it('mu= 与 /link 都取不到音轨时抛错', async () => {
    // /link 落到好看视频（无 BVID），也没有内嵌 B站直链
    const html = '<a href="/link?url=abc">x</a>'
    const source = createBaiduSource({}, biliFetcher(html))
    await expect(source.resolve('不存在的歌')).rejects.toThrow()
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
