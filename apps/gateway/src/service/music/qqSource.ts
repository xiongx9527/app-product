import {
  genreToKeyword,
  paramString,
  type MusicFetcher,
  type MusicSource,
  type ResolvedTrack,
} from './types'

const QQ_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
const QQ_SONG_URL = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://y.qq.com/',
}

interface QqSearchResp {
  data?: {
    song?: {
      list?: Array<{
        songid: number
        songmid: string
        songname: string
        singer?: Array<{ name: string }>
      }>
    }
  }
}
interface QqUrlResp {
  data?: Array<{ url?: string; songmid?: string }>
}

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, { method: init?.method, headers: init?.headers, body: init?.body }) as unknown as ReturnType<MusicFetcher>

/**
 * QQ 音乐：走其公开 Web API 搜歌并取播放直链（无需 Key，但部分 VIP 歌曲无直链）。
 * 解析逻辑用注入的 fetcher 单测覆盖；线上可用性属尽力而为。
 * next() 用递增页码（p）取下一条候选，实现「换一首 / 换个风格」。
 */
export function createQqSource(
  params: Record<string, string | number | boolean> = {},
  fetcher: MusicFetcher = nativeFetch
): MusicSource {
  const limit = Math.max(1, Math.min(30, Number(paramString(params, 'limit', '1')) || 1))
  let offset = 0

  async function at(genre: string | undefined, off: number): Promise<ResolvedTrack> {
    const keyword = genreToKeyword(genre)
    const searchUrl = `${QQ_SEARCH}?${new URLSearchParams({
      w: keyword,
      format: 'json',
      p: String(off + 1),
      n: String(limit),
      cr: '1',
    }).toString()}`
    const searchResp = await fetcher(searchUrl, { headers: HEADERS })
    const search = (await searchResp.json()) as QqSearchResp
    const song = search.data?.song?.list?.[0]
    if (!song) throw new Error(`QQ 音乐未搜到「${keyword}」相关歌曲`)
    const urlUrl = `${QQ_SONG_URL}?${new URLSearchParams({
      songmid: song.songmid,
      format: 'json',
    }).toString()}`
    const urlResp = await fetcher(urlUrl, { headers: HEADERS })
    const urlData = (await urlResp.json()) as QqUrlResp
    const url = urlData.data?.[0]?.url
    if (!url) throw new Error(`QQ 音乐歌曲「${song.songname}」暂无可播放直链`)
    const singer = song.singer?.[0]?.name
    return {
      url,
      title: singer ? `${song.songname} - ${singer}` : song.songname,
      channel: 'qq',
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
