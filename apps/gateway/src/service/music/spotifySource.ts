import {
  genreToKeyword,
  paramString,
  type MusicFetcher,
  type MusicSource,
} from './types'

const SPOTIFY_TOKEN = 'https://accounts.spotify.com/api/token'
const SPOTIFY_SEARCH = 'https://api.spotify.com/v1/search'

interface TokenResp {
  access_token?: string
  expires_in?: number
}

interface SpotifySearchResp {
  tracks?: {
    items?: Array<{
      name: string
      preview_url: string | null
      artists?: Array<{ name: string }>
    }>
  }
}

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, { method: init?.method, headers: init?.headers, body: init?.body }) as unknown as ReturnType<MusicFetcher>

/**
 * Spotify：用 client credentials 取 token，再搜歌取 30 秒试听直链。
 * 需要用户在设置页填 clientId/clientSecret；试听仅 30 秒（Spotify 开放接口限制）。
 * 解析逻辑用注入的 fetcher 单测覆盖；线上可用性属尽力而为。
 */
export function createSpotifySource(
  params: Record<string, string | number | boolean> = {},
  fetcher: MusicFetcher = nativeFetch
): MusicSource {
  const clientId = paramString(params, 'clientId')
  const clientSecret = paramString(params, 'clientSecret')
  let token: string | null = null
  let tokenExpiry = 0

  async function ensureToken(): Promise<string> {
    if (token && Date.now() < tokenExpiry) return token
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const resp = await fetcher(SPOTIFY_TOKEN, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    const data = (await resp.json()) as TokenResp
    if (!data.access_token) throw new Error('Spotify 获取 token 失败：检查 clientId/clientSecret')
    token = data.access_token
    tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000 - 30_000
    return token
  }

  return {
    async resolve(genre?: string) {
      const keyword = genreToKeyword(genre)
      const access = await ensureToken()
      const searchUrl = `${SPOTIFY_SEARCH}?${new URLSearchParams({
        q: keyword,
        type: 'track',
        limit: '1',
      }).toString()}`
      const resp = await fetcher(searchUrl, {
        headers: { Authorization: `Bearer ${access}` },
      })
      const data = (await resp.json()) as SpotifySearchResp
      const track = data.tracks?.items?.[0]
      if (!track) throw new Error(`Spotify 未搜到「${keyword}」相关曲目`)
      if (!track.preview_url) throw new Error(`Spotify 曲目「${track.name}」无试听直链`)
      const artist = track.artists?.[0]?.name
      return {
        url: track.preview_url,
        title: artist ? `${track.name} - ${artist}` : track.name,
        channel: 'spotify',
      }
    },
  }
}
