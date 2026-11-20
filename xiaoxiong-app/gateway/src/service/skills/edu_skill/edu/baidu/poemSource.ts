/**
 * 百度汉语诗词/古文数据源（edu）。
 *
 * 链路（2026-11-17 逆向，用户确认 sid 来自百度搜索点详情）：
 *   作品名 → 百度搜索页（移动 UA，无验证码）→ aladdin 卡片里的 32 位 sid
 *          → poemdetail?sid 拿逐句原文 + 百度朗读 mp3
 *
 * 百度汉语搜索页本身是 JS 渲染 + seccaptcha 验证码，拿不到数据；edu-web-go/hanyu/search
 * 返回固定推荐列表（非真搜索），也不能按名找 sid。故走百度搜索页提取 sid 这条路。
 * aladdin 卡片覆盖因词条而异：多数作品能提到；提不到就返回 null，由上层诚实回退，
 * 绝不编造诗词内容。
 */
const BAIDU_SEARCH = 'https://www.baidu.com/s?wd='
const POEM_DETAIL = 'https://hanyuapp.baidu.com/dictapp/swan/poemdetail?sid='
/** 百度搜索页对裸 curl/PC UA 会 302 到 seccaptcha，移动 UA 才稳定返回 aladdin 卡片。 */
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'

export interface EduFetcher {
  (url: string, init?: { headers?: Record<string, string> }): Promise<{
    ok: boolean
    text: () => Promise<string>
  }>
}

export interface PoemEntry {
  /** 作品名（如「岳阳楼记」） */
  title: string
  /** 作者 */
  author: string
  /** 朝代 */
  dynasty: string
  /** sid */
  sid: string
  /** 逐句原文（拼成可显示文本） */
  lines: string[]
  /** 百度朗读 mp3 直链（可选） */
  audioUrl?: string
  /** 百度汉语详情页链接（可选） */
  link?: string
}

/**
 * 从百度搜索页 HTML 里提取诗词 aladdin 卡片的 sid。
 * 两种形态：hanyu.baidu.com/shici/detail?...pid=<32hex> 或
 * hanyu-poem-(voice|mp3).cdn.bcebos.com/[man/]<32hex>.mp3。
 * 注意 pid 不一定紧跟在 `?` 后：滕王阁序的卡片是 `?from=aladdin&pid=...`，
 * 旧正则只认 `?pid=` 才漏掉它（2026-11-18 真机「暂时没找到《滕王阁序》」根因）。
 */
export function extractPoemSid(html: string): string | null {
  const fromDetail = /hanyu\.baidu\.com\/shici\/detail[^"'\s<>]*?[?&](?:amp;)?pid=([0-9a-f]{32})/i.exec(html)
  if (fromDetail) return fromDetail[1]
  const fromAudio = /hanyu-poem-(?:voice|mp3)\.cdn\.bcebos\.com\/(?:man\/)?([0-9a-f]{32})\.mp3/i.exec(html)
  return fromAudio ? fromAudio[1] : null
}

/** 解析 poemdetail 接口返回的 JSON 为 PoemEntry。纯函数便于单测。 */
export function parsePoemDetail(raw: string, sid: string, fallbackTitle: string): PoemEntry | null {
  let d: {
    errno?: number
    data?: {
      name?: string
      author?: string
      dynasty?: string
      voiceInfo?: { url?: string }
      poemLines?: Array<{ source?: string; punc?: string }>
    }
  }
  try {
    d = JSON.parse(raw)
  } catch {
    return null
  }
  if (d.errno !== 0 || !d.data) return null
  const data = d.data
  const lines = (data.poemLines ?? [])
    .map((l) => (l.source ?? '') + (l.punc ?? ''))
    .filter((s) => s.trim())
  if (!lines.length) return null
  let audioUrl = data.voiceInfo?.url || undefined
  if (audioUrl && audioUrl.startsWith('http://')) audioUrl = 'https://' + audioUrl.slice(7)
  return {
    title: data.name || fallbackTitle,
    author: data.author ?? '',
    dynasty: data.dynasty ?? '',
    sid,
    lines,
    ...(audioUrl ? { audioUrl } : {}),
    link: `https://hanyu.baidu.com/shici/detail?pid=${sid}`,
  }
}

/**
 * 按作品名查诗词：百度搜索页提 sid → poemdetail 拿原文+mp3。
 * 搜索页/详情任一步失败或无结果返回 null（上层回退 LLM）。
 */
export async function queryPoem(title: string, fetcher: EduFetcher = fetch as unknown as EduFetcher): Promise<PoemEntry | null> {
  const q = (title || '').trim()
  if (!q) return null
  try {
    const searchRes = await fetcher(`${BAIDU_SEARCH}${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    })
    if (!searchRes.ok) return null
    const sid = extractPoemSid(await searchRes.text())
    if (!sid) return null
    const detailRes = await fetcher(`${POEM_DETAIL}${sid}`, { headers: { 'User-Agent': MOBILE_UA } })
    if (!detailRes.ok) return null
    return parsePoemDetail(await detailRes.text(), sid, q)
  } catch {
    return null
  }
}
