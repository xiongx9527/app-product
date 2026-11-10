import type { MusicFetcher } from '../types'
import type { SubtitleLine } from '../../../protocol'
import { parseLrc } from './parseLrc'

const KG_SEARCH = 'http://lyrics.kugou.com/search'
const KG_DOWNLOAD = 'http://lyrics.kugou.com/download'
const KG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
}

const nativeFetch: MusicFetcher = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<MusicFetcher>

interface KgCandidate {
  id?: string | number
  accesskey?: string
  singer?: string
  song?: string
  score?: number
}

interface KgSearchResult {
  status?: number
  candidates?: KgCandidate[]
}

interface KgDownloadResult {
  status?: number
  content?: string
  fmt?: string
}

/** 归一化：小写、去空白，便于歌手/歌名模糊匹配。 */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '')
}

/**
 * 从酷狗歌词候选里挑最像正版的：歌手命中优先（加权），其次歌名前缀命中；
 * 指定歌手时只在「歌手命中」的候选里挑，避免拿错人的词。任意环节失败返回 null。
 */
function pickBest(cands: KgCandidate[], artist: string, title: string): KgCandidate | null {
  if (!cands.length) return null
  const wantArtist = norm(artist)
  const wantTitle = norm(title)
  const scored = cands.map((c) => {
    const singer = norm(c.singer ?? '')
    const song = norm(c.song ?? '')
    let score = typeof c.score === 'number' ? c.score : 0
    if (wantArtist && singer.includes(wantArtist)) score += 1000
    if (wantTitle && song && (song.startsWith(wantTitle) || wantTitle.startsWith(song))) score += 500
    return { c, score }
  })
  // 指定歌手时只在歌手命中的候选里挑，避免错配歌词（如不同人翻唱同名）。
  const pool = wantArtist ? scored.filter((x) => x.score >= 1000) : scored
  if (!pool.length) return null
  pool.sort((a, b) => b.score - a.score)
  return pool[0].c
}

/**
 * 从酷狗歌词库取歌词（带时间轴）：按「歌手 歌名」检索候选，挑正版后拉 LRC。
 * 酷狗歌词检索与下载均免登录（带 UA 即可），对有版权的歌手（如周杰伦）能补上网易云缺的词；
 * 下载内容经 base64 编码，需解码后再解析 LRC。任意环节失败/取不到都返回 null，由上层回退「暂无字幕」。
 */
export async function getKugouLyrics(
  artist: string,
  title: string,
  fetcher: MusicFetcher = nativeFetch
): Promise<SubtitleLine[] | null> {
  const query = `${artist} ${title}`.trim()
  let cands: KgCandidate[] = []
  try {
    const resp = await fetcher(
      `${KG_SEARCH}?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(query)}&duration=`,
      { headers: KG_HEADERS }
    )
    if (!resp.ok) return null
    const data = (await resp.json()) as KgSearchResult
    cands = data.candidates ?? []
  } catch {
    return null
  }
  const cand = pickBest(cands, artist, title)
  if (!cand || !cand.id || !cand.accesskey) return null
  try {
    const resp = await fetcher(
      `${KG_DOWNLOAD}?ver=1&client=pc&id=${encodeURIComponent(String(cand.id))}` +
        `&accesskey=${encodeURIComponent(cand.accesskey)}&fmt=lrc&charset=utf8`,
      { headers: KG_HEADERS }
    )
    if (!resp.ok) return null
    const data = (await resp.json()) as KgDownloadResult
    const raw = data.content
    if (data.status !== 200 || !raw) return null
    // 下载内容是 base64 编码的 LRC 文本，解码后再按 LRC 解析。
    const decoded = Buffer.from(raw, 'base64').toString('utf-8')
    const lines = parseLrc(decoded)
    return lines.length ? lines : null
  } catch {
    return null
  }
}
