import { describe, it, expect } from 'vitest'
import { createSomaSource } from './somaSource'
import { createCustomSource } from './customSource'
import { createNeteaseSource } from './neteaseSource'
import { createQqSource } from './qqSource'
import { createSpotifySource } from './spotifySource'
import { createMusicSource } from './index'
import { SOMA_CHANNELS } from '../tools/musicChannels'
import type { MusicFetcher } from './types'

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
})
