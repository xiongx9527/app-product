import { describe, it, expect } from 'vitest'
import { createSomaSource } from './somaSource'
import { createBaiduSource } from './baiduSource'
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
  it('搜到 B 站视频则抽音轨返回可播放地址', async () => {
    const fetcher: MusicFetcher = async (url) => {
      if (url.includes('baidu.com/s')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => '<a href="/link?url=abc">B站</a><a href="/link?url=def">好看</a>',
          url: url,
        }
      }
      // 第一个 /link 跳到 B 站视频页，抽到 bvid
      if (url.includes('/link?url=abc')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => '',
          url: 'https://www.bilibili.com/video/BV1xx411c7mD',
        }
      }
      // B 站 wbi 签名所需的 nav（拿 wbi_img）
      if (url.includes('x/web-interface/nav')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { wbi_img: { img_url: 'https://i0.hdslb.com/wbi/xxx.png', sub_url: 'https://i0.hdslb.com/wbi/yyy.png' } } }),
          text: async () => '',
        }
      }
      // B 站音轨接口
      if (url.includes('wbi/view')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 0, data: { cid: 123, title: '稻香' } }),
          text: async () => '',
        }
      }
      expect(url).toContain('wbi/playurl')
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { dash: { audio: [{ bandwidth: 1, baseUrl: 'https://bili/audio.m4s' }] } } }),
        text: async () => '',
      }
    }
    const source = createBaiduSource({}, fetcher)
    const track = await source.resolve('稻香')
    expect(track.url).toBe('https://bili/audio.m4s')
    expect(track.channel).toBe('bilibili')
    expect(track.title).toBe('稻香')
  })

  it('所有结果都抽不到音轨时抛错', async () => {
    const fetcher: MusicFetcher = async (url) => {
      if (url.includes('baidu.com/s')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => '<a href="/link?url=abc">x</a>',
          url: url,
        }
      }
      // 跳转结果不是 B 站，抽不到音轨
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
        url: 'https://other.com/page',
      }
    }
    const source = createBaiduSource({}, fetcher)
    await expect(source.resolve('不存在的歌')).rejects.toThrow()
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
