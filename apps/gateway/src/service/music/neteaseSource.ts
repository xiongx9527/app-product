import {
  genreToKeyword,
  paramString,
  type MusicFetcher,
  type MusicSource,
  type ResolvedTrack,
} from './types'

const NCM_SEARCH = 'https://music.163.com/api/search/get'
const NCM_SONG_URL = 'https://music.163.com/api/song/enhance/player/url'
const UA = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' }

interface NcmSearchResp {
  result?: { songs?: Array<{ id: number; name: string; artists?: Array<{ name: string }> }> }
}
interface NcmUrlResp {
  data?: Array<{ id: number; url: string | null; br?: number }>
}

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, { method: init?.method, headers: init?.headers, body: init?.body }) as unknown as ReturnType<MusicFetcher>

/**
 * 网易云音乐：走其公开 Web API 搜歌并取播放直链（无需 Key，但限速/偶发 403）。
 * 解析逻辑用注入的 fetcher 单测覆盖；线上可用性属尽力而为。
 * next() 用递增 offset 取下一条候选，实现「换一首 / 换个风格」。
 */
export function createNeteaseSource(
  params: Record<string, string | number | boolean> = {},
  fetcher: MusicFetcher = nativeFetch
): MusicSource {
  const limit = Math.max(1, Math.min(10, Number(paramString(params, 'limit', '1')) || 1))
  let offset = 0

  async function at(genre: string | undefined, off: number): Promise<ResolvedTrack> {
    const keyword = genreToKeyword(genre)
    const searchBody = new URLSearchParams({
      s: keyword,
      type: '1',
      limit: String(limit),
      offset: String(off),
    }).toString()
    const searchResp = await fetcher(NCM_SEARCH, {
      method: 'POST',
      headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: searchBody,
    })
    const search = (await searchResp.json()) as NcmSearchResp
    const song = search.result?.songs?.[0]
    if (!song) throw new Error(`网易云未搜到「${keyword}」相关歌曲`)
    const urlBody = new URLSearchParams({
      id: String(song.id),
      ids: `[${song.id}]`,
      br: '320000',
    }).toString()
    const urlResp = await fetcher(NCM_SONG_URL, {
      method: 'POST',
      headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: urlBody,
    })
    const urlData = (await urlResp.json()) as NcmUrlResp
    const url = urlData.data?.[0]?.url
    if (!url) throw new Error(`网易云歌曲「${song.name}」暂无可播放直链`)
    const artist = song.artists?.[0]?.name
    return {
      url,
      title: artist ? `${song.name} - ${artist}` : song.name,
      channel: 'netease',
    }
  }

  return {
    async resolve(genre?: string) {
      offset = 0
      return at(genre, offset)
    },
    async next(genre?: string) {
      offset += 1
      return at(genre, offset)
    },
  }
}
