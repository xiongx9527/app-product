import type { MusicFetcher } from '../types'
import type { SubtitleLine } from '../../../protocol'
import { parseLrc } from './parseLrc'

const NC_BASE = 'https://music.163.com'
const NC_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Referer: 'https://music.163.com/',
}

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<MusicFetcher>

interface NcArtist {
  name?: string
}
interface NcSong {
  id: number
  name?: string
  artists?: NcArtist[]
}
interface NcSearchResult {
  result?: { songs?: NcSong[] }
}
interface NcLyricResult {
  code?: number
  lrc?: { lyric?: string }
}

/** 归一化：小写、去空白，便于歌手/歌名模糊匹配。 */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '')
}

/**
 * 从网易云搜索结果里挑最像正版的候选：歌手命中优先，其次标题前缀命中；
 * 翻唱/现场/Remix/伴奏等作为降权项，避免拿到明显不是原唱的版本。
 * 指定歌手时，必须歌手命中才采用——否则宁可返回 null 也不展示非同一人的歌词
 * （如周杰伦 一路向北在网易云只有翻唱，不应拿翻唱歌词冒充原唱）。
 * 网易云对部分歌手（如周杰伦）曲库受限，搜不到正版时返回 null，由上层回退「暂无字幕」。
 */
function pickBest(songs: NcSong[], artist: string, title: string): NcSong | null {
  if (!songs.length) return null
  const wantArtist = norm(artist)
  const wantTitle = norm(title)
  const scored = songs.map((s) => {
    const artistName = norm((s.artists ?? []).map((a) => a.name ?? '').join(''))
    const songTitle = norm(s.name ?? '')
    const isOff = /翻唱|cover|现场|live|remix|混音|伴奏|dj|变速/.test(songTitle + artistName)
    let score = 0
    if (wantArtist && artistName.includes(wantArtist)) score += 2
    if (songTitle.startsWith(wantTitle)) score += 1
    if (isOff && !songTitle.startsWith(wantTitle)) score -= 1
    return { s, score }
  })
  // 指定歌手时只在「歌手命中」的候选里挑，避免错配歌词。
  const candidates = wantArtist ? scored.filter((x) => x.score >= 2) : scored
  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0].score >= 0 ? candidates[0].s : null
}

/**


 * 从网易云取歌词（带时间轴）：按「歌手 歌名」检索，挑正版候选后拉 LRC。
 * 网易云无需签名，稳定可用，覆盖大多数歌曲；曲库受限的歌手（如周杰伦）搜不到正版时返回 null。
 * 任意环节失败/取不到都返回 null，由上层回退「暂无字幕」。
 */
export async function getNeteaseLyrics(
  artist: string,
  title: string,
  fetcher: MusicFetcher = nativeFetch
): Promise<SubtitleLine[] | null> {
  const query = `${artist} ${title}`.trim()
  let songs: NcSong[] = []
  try {
    const resp = await fetcher(
      `${NC_BASE}/api/search/get?type=1&s=${encodeURIComponent(query)}`,
      { headers: NC_HEADERS }
    )
    if (!resp.ok) return null
    const data = (await resp.json()) as NcSearchResult
    songs = data.result?.songs ?? []
  } catch {
    return null
  }
  const song = pickBest(songs, artist, title)
  if (!song) return null
  try {
    const resp = await fetcher(
      `${NC_BASE}/api/song/lyric?id=${song.id}&lv=-1&kv=-1&tv=-1`,
      { headers: NC_HEADERS }
    )
    if (!resp.ok) return null
    const data = (await resp.json()) as NcLyricResult
    const raw = data.lrc?.lyric ?? ''
    // 网易云对无歌词的曲子返回「暂无歌词」占位，视为无字幕。
    if (!raw || raw.includes('暂无歌词')) return null
    const lines = parseLrc(raw)
    return lines.length ? lines : null
  } catch {
    return null
  }
}
