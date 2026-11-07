import { describe, it, expect } from 'vitest'
import { createSomaSource } from './somaSource'
import { createCustomSource } from './customSource'
import { createNeteaseSource } from './neteaseSource'
import { createQqSource } from './qqSource'
import { createSpotifySource } from './spotifySource'
import { createMusicSource, withSomaFallback } from './index'
import { SOMA_CHANNELS } from '../tools/musicChannels'
import type { MusicFetcher, MusicSource } from './types'

describe('music sources', () => {
  it('soma：无风格时用配置的默认频道', async () => {
    const source = createSomaSource({ station: 'sonicuniverse' })
    const track = await source.resolve()
    expect(track.channel).toBe('sonicuniverse')
    expect(track.url).toContain('sonicuniverse')
  })

  it('soma：按风格选台（爵士 → sonicuniverse）', async () => {
    const source = createSomaSource({})
    const track = await source.resolve('放点爵士')
    expect(track.channel).toBe('sonicuniverse')
  })

  it('soma：灵魂乐/节奏类走 7soul，不和爵士串台', async () => {
    const source = createSomaSource({})
    expect((await source.resolve('放点 soul')).channel).toBe('7soul')
    expect((await source.resolve('来点灵魂乐')).channel).toBe('7soul')
    expect((await source.resolve('放点蓝调')).channel).toBe('sonicuniverse')
  })

  it('soma：频道表 id 唯一且都指向 ice6 直链', async () => {
    const ids = SOMA_CHANNELS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const channel of SOMA_CHANNELS) {
      expect(channel.url).toBe(`https://ice6.somafm.com/${channel.id}-128-mp3`)
    }
  })

  it('custom：直接返回用户填的地址与标题', async () => {
    const source = createCustomSource({ streamUrl: 'https://x/y.mp3', title: '我的电台' })
    const track = await source.resolve('随便')
    expect(track.url).toBe('https://x/y.mp3')
    expect(track.title).toBe('我的电台')
    expect(track.channel).toBe('custom')
  })

  it('netease：搜歌后取直链，标题带歌手', async () => {
    const fetcher: MusicFetcher = async (url) => {
      if (url.includes('api/search/get')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            result: { songs: [{ id: 123, name: '七里香', artists: [{ name: '周杰伦' }] }] },
          }),
          text: async () => '',
        }
      }
      expect(url).toContain('song/enhance/player/url')
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 123, url: 'https://music.example/1.mp3' }] }),
        text: async () => '',
      }
    }
    const source = createNeteaseSource({}, fetcher)
    const track = await source.resolve('流行')
    expect(track.url).toBe('https://music.example/1.mp3')
    expect(track.title).toBe('七里香 - 周杰伦')
    expect(track.channel).toBe('netease')
  })

  it('netease：搜不到歌时抛错', async () => {
    const fetcher: MusicFetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { songs: [] } }),
      text: async () => '',
    })
    const source = createNeteaseSource({}, fetcher)
    await expect(source.resolve('不存在')).rejects.toThrow()
  })

  it('qq：搜歌后取直链', async () => {
    const fetcher: MusicFetcher = async (url) => {
      if (url.includes('client_search_cp')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              song: {
                list: [{ songid: 1, songmid: 'MID', songname: '晴天', singer: [{ name: '周杰伦' }] }],
              },
            },
          }),
          text: async () => '',
        }
      }
      expect(url).toContain('fcg_play_single_song')
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ url: 'https://qq.example/1.mp3' }] }),
        text: async () => '',
      }
    }
    const source = createQqSource({}, fetcher)
    const track = await source.resolve('流行')
    expect(track.url).toBe('https://qq.example/1.mp3')
    expect(track.title).toBe('晴天 - 周杰伦')
    expect(track.channel).toBe('qq')
  })

  it('spotify：取 token 后搜歌返回试听直链', async () => {
    const fetcher: MusicFetcher = async (url) => {
      if (url.includes('accounts.spotify.com/api/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'tok', expires_in: 3600 }),
          text: async () => '',
        }
      }
      expect(url).toContain('api.spotify.com/v1/search')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tracks: {
            items: [
              { name: 'Shape of You', preview_url: 'https://sp.example/p.mp3', artists: [{ name: 'Ed Sheeran' }] },
            ],
          },
        }),
        text: async () => '',
      }
    }
    const source = createSpotifySource({ clientId: 'id', clientSecret: 'secret' }, fetcher)
    const track = await source.resolve('流行')
    expect(track.url).toBe('https://sp.example/p.mp3')
    expect(track.title).toBe('Shape of You - Ed Sheeran')
  })

  it('createMusicSource 按 provider 分发；未知/空返回 undefined', () => {
    expect(createMusicSource({ provider: 'soma', params: {} })).toBeTruthy()
    expect(createMusicSource({ provider: 'custom', params: {} })).toBeTruthy()
    expect(createMusicSource({ provider: 'unknown', params: {} })).toBeUndefined()
    expect(createMusicSource(undefined)).toBeUndefined()
  })

  describe('音乐换一首 / 换个风格（next）', () => {
    it('soma：next 切换到一个不同的频道', async () => {
      const source = createSomaSource({ station: 'groovesalad' })
      const first = await source.resolve()
      const second = await source.next!()
      expect(second.channel).not.toBe(first.channel)
      expect(second.url).toContain(second.channel)
    })

    it('soma：next 带风格时优先切到该风格下的其它频道', async () => {
      const source = createSomaSource({ station: 'groovesalad' })
      const first = await source.resolve() // groovesalad
      const jazz = await source.next!('爵士') // groovesalad 不是爵士，应切到 sonicuniverse
      expect(jazz.channel).toBe('sonicuniverse')
      expect(first.channel).not.toBe('sonicuniverse')
    })

    it('netease：next 取下一条候选（offset 递增，曲目不同）', async () => {
      const fetcher: MusicFetcher = async (url, init) => {
        const body = (init?.body as string) ?? ''
        if (url.includes('api/search/get')) {
          const off = Number(/offset=(\d+)/.exec(body)?.[1] ?? '0')
          const song =
            off === 0
              ? { id: 1, name: 'A', artists: [{ name: 'x' }] }
              : { id: 2, name: 'B', artists: [{ name: 'y' }] }
          return { ok: true, status: 200, json: async () => ({ result: { songs: [song] } }), text: async () => '' }
        }
        const id = /id=(\d+)/.exec(body)?.[1] ?? '0'
        return { ok: true, status: 200, json: async () => ({ data: [{ id: Number(id), url: `https://m/${id}.mp3` }] }), text: async () => '' }
      }
      const source = createNeteaseSource({}, fetcher)
      const first = await source.resolve('流行')
      const second = await source.next!('流行')
      expect(first.title).toBe('A - x')
      expect(second.title).toBe('B - y')
      expect(first.url).not.toBe(second.url)
    })

    it('qq：next 取下一条候选（页码递增，曲目不同）', async () => {
      const fetcher: MusicFetcher = async (url) => {
        if (url.includes('client_search_cp')) {
          const p = Number(/p=(\d+)/.exec(url)?.[1] ?? '1')
          const song =
            p === 1
              ? { songid: 1, songmid: 'M1', songname: 'A', singer: [{ name: 'x' }] }
              : { songid: 2, songmid: 'M2', songname: 'B', singer: [{ name: 'y' }] }
          return { ok: true, status: 200, json: async () => ({ data: { song: { list: [song] } } }), text: async () => '' }
        }
        const mid = /songmid=(\w+)/.exec(url)?.[1] ?? 'M0'
        return { ok: true, status: 200, json: async () => ({ data: [{ url: `https://q/${mid}.mp3` }] }), text: async () => '' }
      }
      const source = createQqSource({}, fetcher)
      const first = await source.resolve('流行')
      const second = await source.next!('流行')
      expect(first.title).toBe('A - x')
      expect(second.title).toBe('B - y')
      expect(first.url).not.toBe(second.url)
    })

    it('spotify：next 取下一条候选（offset 递增，曲目不同）', async () => {
      const fetcher: MusicFetcher = async (url) => {
        if (url.includes('accounts.spotify.com/api/token')) {
          return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' }
        }
        const off = Number(/offset=(\d+)/.exec(url)?.[1] ?? '0')
        const track =
          off === 0
            ? { name: 'A', preview_url: 'https://sp/1.mp3', artists: [{ name: 'x' }] }
            : { name: 'B', preview_url: 'https://sp/2.mp3', artists: [{ name: 'y' }] }
        return { ok: true, status: 200, json: async () => ({ tracks: { items: [track] } }), text: async () => '' }
      }
      const source = createSpotifySource({ clientId: 'id', clientSecret: 'secret' }, fetcher)
      const first = await source.resolve('流行')
      const second = await source.next!('流行')
      expect(first.title).toBe('A - x')
      expect(second.title).toBe('B - y')
      expect(first.url).not.toBe(second.url)
    })

    it('custom：next 与 resolve 返回同一固定地址', async () => {
      const source = createCustomSource({ streamUrl: 'https://x/y.mp3', title: '我的电台' })
      const second = await source.next!()
      expect(second.url).toBe('https://x/y.mp3')
      expect(second.title).toBe('我的电台')
    })

    it('withSomaFallback：next 透传到原源；原源失败才回退 SomaFM', async () => {
      const primary: MusicSource = {
        resolve: async () => ({ url: 'https://p/1.mp3', title: 'P1', channel: 'primary' }),
        next: async () => ({ url: 'https://p/2.mp3', title: 'P2', channel: 'primary' }),
      }
      const wrapped = withSomaFallback(primary)
      const next = await wrapped.next!()
      expect(next.url).toBe('https://p/2.mp3')

      const failing: MusicSource = {
        resolve: async () => ({ url: 'https://p/1.mp3', title: 'P1', channel: 'primary' }),
        next: async () => {
          throw new Error('boom')
        },
      }
      const wrappedFail = withSomaFallback(failing)
      const fallback = await wrappedFail.next!()
      expect(fallback.channel).toBeTruthy()
      expect(SOMA_CHANNELS.some((c) => c.id === fallback.channel)).toBe(true)
    })
  })
})
