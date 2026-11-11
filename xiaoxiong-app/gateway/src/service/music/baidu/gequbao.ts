import type { MusicFetcher } from '../types'
import type { SubtitleLine } from '../../../protocol'
import { parseLrc } from '../lyrics/parseLrc'
import { joinArtistTitle } from '../lyrics/query'

/**
 * 候选排序分：歌手 + 歌名都匹配优先（用户规则「歌手+歌名匹配且有歌词」的前半部分）。
 * 子串双向匹配，给分相同；不强制完全相等，避免「周杰伦」「周杰伦 (Live)」这类被漏掉。
 * artist 为空时只按歌名匹配（音频检索常只有关键词）。
 */
function matchScore(c: { title?: string; artist?: string }, artist: string, title: string): number {
  const a = (c.artist ?? '').trim().toLowerCase()
  const t = (c.title ?? '').trim().toLowerCase()
  const na = artist.trim().toLowerCase()
  const nt = title.trim().toLowerCase()
  let score = 0
  if (nt && t && (t.includes(nt) || nt.includes(t))) score += 2
  if (na && a && (a.includes(na) || na.includes(a))) score += 2
  return score
}

/**
 * 歌曲宝（gequbao）歌词/音频源：免费、无需登录，且详情页一次就能拿齐三样同源资源——
 *  - 音频：window.appData.play_id 是加密令牌（opaque，无需解密），
 *    原样回传 /member/common-play-url（purpose=play）即返回可直接播放的 kuwo MP3；
 *  - 封面：window.appData.mp3_cover；
 *  - 歌词：详情页内嵌**带时间轴的 LRC**（#content-lrc），可被 parseLrc 直接吃进去、随进度高亮。
 * 三者出自同一个详情页，天然同源同曲，绝不出现「音频来自 A、字幕配了 B」对不上的情况。
 *
 * 地址只写在网关（客户端不出现），符合「第三方只经网关、地址不落前端」的约定。
 */
const GQ_BASE = 'https://www.gequbao.com'

const GQ_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
}

interface GqCandidate {
  id: string
  title: string
  artist: string
}

/** 从详情页 HTML 抠出带时间轴的 LRC 文本（content-lrc 块，<br> 换行的 [mm:ss.xx] 行）。 */
export function extractLrc(html: string): string {
  const m = html.match(/id="content-lrc"[^>]*>([\s\S]*?)<\/div>/)
  if (!m) return ''
  return m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
}

interface GqAppData {
  play_id?: string
  mp3_cover?: string
  lrc_is_empty?: boolean
}

/** 从详情页 HTML 抠出 window.appData（歌曲宝内嵌的 JSON，引号可能是 \u0022 转义）。 */
export function extractAppData(html: string): GqAppData | null {
  const m = html.match(/window\.appData\s*=\s*JSON\.parse\(\s*'([^']+)'\s*\)/)
  if (!m) return null
  try {
    const json = m[1].replace(/\\u0022/g, '"').replace(/\\"/g, '"')
    return JSON.parse(json) as GqAppData
  } catch {
    return null
  }
}

/** 从详情页 HTML 抠出 play_id 令牌（opaque，无需我们解密，原样回传 common-play-url 即可）。 */
export function extractPlayId(html: string): string | null {
  return extractAppData(html)?.play_id ?? null
}

/**
 * 歌曲宝自己的「无歌词」信号：下载歌词按钮与 initLyrics 都用 appData.lrc_is_empty 判断，
 * 命中即「当前歌曲暂无歌词」。用它的好处是不用解析 HTML 即可权威地判定无歌词，省一次解析。
 */
export function extractLrcIsEmpty(html: string): boolean {
  return extractAppData(html)?.lrc_is_empty === true
}

/**
 * 规范化封面 URL：歌曲宝 appData 里的 mp3_cover 常带 JSON 转义残留
 * （形如 http:\/\/img1.kuwo.cn\/star\/cover.jpg，是非法 URL，<image> 加载不出），
 * 且多为 http 明文（原生 App / H5 混合内容会拦）。清掉残留反斜杠、统一升为 https，
 * 保证客户端 <image> 能直接加载。
 */
export function normalizeCoverUrl(raw?: string): string | undefined {
  if (!raw) return undefined
  const u = raw.replace(/\\/g, '').trim()
  if (!u) return undefined
  if (u.startsWith('//')) return `https:${u}`
  if (u.startsWith('http://')) return `https://${u.slice('http://'.length)}`
  return u
}

/**
 * 搜索词变体：歌曲宝搜索对「X的Y」（如「周杰伦的一路向北」）这类带「的」的口语会扑空，
 * 拆成「歌名 / 歌手 歌名 / 歌手」多试几次，提高命中。去重后返回。
 */
function gequbaoQueryVariants(raw: string): string[] {
  const q = raw.trim()
  const variants = [q]
  const m = q.match(/^(.+?)的(.+)$/)
  if (m) {
    const pre = m[1].trim()
    const post = m[2].trim()
    variants.push(post, `${pre} ${post}`, pre)
  }
  return Array.from(new Set(variants.filter(Boolean)))
}

/**
 * 按关键词搜候选：解析搜索页每个结果 `<a href="/music/ID" title="歌名 - 歌手">`，
 * 按「歌手+歌名匹配」排序，返回候选 id（供详情页取同源音频/封面/歌词）。
 */
async function searchGequbao(query: string, fetcher: MusicFetcher): Promise<GqCandidate[]> {
  const resp = await fetcher(`${GQ_BASE}/s/${encodeURIComponent(query.trim())}`, { headers: GQ_HEADERS })
  if (!resp.ok) return []
  const html = await resp.text()
  const candidates: GqCandidate[] = []
  const re = /href="\/music\/(\d+)"[^>]*title="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attr = m[2]
    const sep = attr.lastIndexOf(' - ')
    candidates.push({
      id: m[1],
      title: sep >= 0 ? attr.slice(0, sep).trim() : attr.trim(),
      artist: sep >= 0 ? attr.slice(sep + 3).trim() : '',
    })
  }
  const t = query.trim()
  candidates.sort((x, y) => matchScore(y, '', t) - matchScore(x, '', t))
  return candidates
}

/** 一次详情页取齐的同源曲目：音频直链 + 封面 + 带时间轴字幕。 */
export interface GequbaoTrack {
  url: string
  cover?: string
  lyrics: SubtitleLine[]
}

/**
 * 解析一首歌的可播放资源：搜候选 → 取详情页 → 从**同一个详情页**拿 play_id（音频令牌）、
 * mp3_cover（封面）、#content-lrc（字幕），再回传 common-play-url 取音频直链。
 * 音频/封面/字幕天然同源同曲。都取不到返回 null，由调用方回退到 B 站。
 * fetcher 可注入，便于单测用桩替换。
 */
export async function resolveGequbaoTrack(
  query: string,
  fetcher: MusicFetcher,
): Promise<GequbaoTrack | null> {
  for (const q of gequbaoQueryVariants(query)) {
    const candidates = await searchGequbao(q, fetcher)
    for (const c of candidates.slice(0, 3)) {
      try {
        const d = await fetcher(`${GQ_BASE}/music/${c.id}`, { headers: GQ_HEADERS })
        if (!d.ok) continue
        const html = await d.text()
        const app = extractAppData(html)
        if (!app?.play_id) continue
        const r = await fetcher(`${GQ_BASE}/member/common-play-url`, {
          method: 'POST',
          headers: {
            ...GQ_HEADERS,
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${GQ_BASE}/music/${c.id}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `id=${encodeURIComponent(app.play_id)}&purpose=play`,
        })
        if (!r.ok) continue
        const j = (await r.json()) as { code?: number; data?: { url?: string } }
        if (j.code !== 1 || !j.data?.url) continue
        // 字幕与音频出自同一详情页：严格同源同曲，绝不跨条目配词
        const lyrics = app.lrc_is_empty ? [] : parseLrc(extractLrc(html))
        return { url: j.data.url, cover: normalizeCoverUrl(app.mp3_cover), lyrics }
      } catch {
        // 该候选失败，试下一个
      }
    }
  }
  return null
}

/**
 * 同源平台内按「歌手 + 歌名」单独取歌词（供显式字幕工具等独立调用）。
 * 详情页带「的」的口语检索会扑空，故按变体多试；返回第一个确有歌词的候选。都取不到返回 null。
 */
export async function getGequbaoLyrics(
  artist: string,
  title: string,
  fetcher: MusicFetcher,
): Promise<SubtitleLine[] | null> {
  for (const q of gequbaoQueryVariants(joinArtistTitle(artist, title))) {
    const candidates = await searchGequbao(q, fetcher)
    for (const c of candidates.slice(0, 3)) {
      try {
        const d = await fetcher(`${GQ_BASE}/music/${c.id}`, { headers: GQ_HEADERS })
        if (!d.ok) continue
        const html = await d.text()
        if (extractLrcIsEmpty(html)) continue // 该候选无歌词，试下一个（与歌曲宝自身判定一致）
        const lines = parseLrc(extractLrc(html))
        if (lines.length) return lines
      } catch {
        // 单条失败不影响，试下一个候选
      }
    }
  }
  return null
}

/**
 * 按歌曲宝取某首歌的可播放音频直链（同源组合里的音频部分）。
 * 复用 resolveGequbaoTrack，拿不到（限流/下架/搜索词带「的」）返回 null，由调用方回退到 B 站。
 */
export async function getGequbaoAudioUrl(query: string, fetcher: MusicFetcher): Promise<string | null> {
  const track = await resolveGequbaoTrack(query, fetcher)
  return track?.url ?? null
}
