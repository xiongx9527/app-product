/**
 * 百度百科数据源（默认源，无 api-key）：抓百度搜索结果页，从结果 JSON 里取「百度百科」卡片的摘要。
 *
 * 为什么抓搜索页而不是词条页：
 * - 词条页 https://baike.baidu.com/item/XXX 有百度安全验证（403），服务端/设备内都过不去；
 * - 搜索结果 https://www.baidu.com/s?wd=XXX 正常返回（200），且 JSON 里自带百科卡片摘要：
 *   - 人物/实体卡：字段 `description`，标题在 `tools.title`；
 *   - 概念卡：字段 `abstract.abstract`，标题在 `character.title` / `tts.title`。
 *   两种卡片都有 `"source":"百度百科"` 锚点，摘要含 <em> 高亮标签需清洗。
 *
 * 摘要用局部正则抓取而非整块 JSON.parse：这些字段嵌在搜索页一个巨大的 JSON 对象里，
 * 整块 parse 拿不到；局部字段正则对两类卡片都稳定（见 baiduBaikeSource.test.ts）。
 */

import type { BaikeEntry, BaikeFetcher, BaikeSource } from './types'

/** 与好价源一致的浏览器 UA：百度对裸 curl 有反爬，带 UA 才稳定拿到搜索页。 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 清洗摘要/标题：去 <em>/<b> 等 HTML 标签、解实体、压空白、去「- 百度百科」后缀。 */
export function cleanBaikeText(raw: string): string {
  let s = raw
  try {
    // 字段值来自 JSON 字符串，先尝试反转义（\uXXXX、\" 等）
    s = JSON.parse(`"${s.replace(/"/g, '\\"')}"`)
  } catch {
    // 反转义失败就用原串（调用方也可能已 decode）
  }
  s = s.replace(/<[^>]+>/g, '') // 去 <em> 等高亮标签
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/\s*[-—–]\s*百度百科\s*$/, '').trim()
  return s
}

/**
 * 从百度搜索结果页 HTML 里解析百科卡片，纯函数便于单测。
 * 取第一个含中文摘要的「百度百科」卡片；没有返回 null。
 */
/**
 * 读取 JSON 中某个字符串字段的值：从字段名的冒号后开始，逐字符扫到未转义的引号为止。
 * 空值（""）返回空串；绝不跨字段/跨卡片，比复杂正则稳健。
 */
function readJsonString(s: string, fieldStart: number): string {
  // fieldStart 指向 "字段名" 的起始引号；找到它的冒号后的值引号
  let i = fieldStart
  // 跳过字段名字符串
  i = s.indexOf('"', i + 1)
  while (i >= 0 && s[i - 1] === '\\') i = s.indexOf('"', i + 1)
  if (i < 0) return ''
  // 找冒号
  const colon = s.indexOf(':', i)
  if (colon < 0) return ''
  // 跳过空白，找值的起始引号
  let v = colon + 1
  while (v < s.length && /\s/.test(s[v])) v++
  if (s[v] !== '"') return ''
  v++
  // 逐字符读到未转义的结束引号
  let out = ''
  while (v < s.length) {
    const c = s[v]
    if (c === '\\') {
      out += c + (s[v + 1] ?? '')
      v += 2
    } else if (c === '"') {
      break
    } else {
      out += c
      v++
    }
  }
  return out
}

/**
 * 从百度搜索结果页 HTML 里解析百科卡片，纯函数便于单测。
 * 取第一个含中文摘要的「百度百科」卡片；没有返回 null。
 */
export function parseBaikeHtml(html: string): BaikeEntry | null {
  // 两种卡片的锚点不同：
  // 实体卡（人物）→ "source":"百度百科"（字符串）
  // 概念卡（词条）→ "source":{"title":"百度百科"}（对象）
  const anchors = [
    ...html.matchAll(/"source"\s*:\s*"百度百科"/g),
    ...html.matchAll(/"source"\s*:\s*\{[^}]{0,200}?"title"\s*:\s*"百度百科"/g),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  for (let ai = 0; ai < anchors.length; ai++) {
    const idx = anchors[ai].index ?? 0
    const nextIdx = ai + 1 < anchors.length ? (anchors[ai + 1].index ?? html.length) : html.length
    // 摘要可能在本卡锚点之前（概念卡的 abstract）或之后（实体卡的 description）；
    // 标题一律在锚点之后（tools.title / character.title / kgTitlePlain）。
    // 两块都向后截到下一锚点前，避免串入相邻卡片。
    const backFrom = Math.max(0, idx - 9000)
    const endAt = Math.min(nextIdx, idx + 2000)
    const summaryWin = html.slice(backFrom, endAt)
    // 实体卡的 tools.title 在 source 锚点前、概念卡的 character.title 在锚点后——
    // 标题与摘要共用同一窗口（前 9000 / 后 2000，向后截到下一锚点），两者都能覆盖。
    const titleWin = summaryWin

    // 标题（仅在锚点之后找）：tools.title 优先，其次 character.title，再退 kgTitlePlain
    let rawTitle = ''
    const toolsPos = titleWin.indexOf('"tools"')
    if (toolsPos >= 0) {
      const tp = titleWin.indexOf('"title"', toolsPos)
      if (tp >= 0) rawTitle = readJsonString(titleWin, tp)
    }
    if (!rawTitle) {
      const charPos = titleWin.indexOf('"character"')
      const ct = charPos >= 0 ? titleWin.indexOf('"title"', charPos) : -1
      if (ct >= 0) rawTitle = readJsonString(titleWin, ct)
    }
    if (!rawTitle) {
      const kt = titleWin.indexOf('"kgTitlePlain"')
      if (kt >= 0) rawTitle = readJsonString(titleWin, kt)
    }
    // 兜底：搜索卡片里形如 "title":"XX - 百度百科" 的标题
    if (!rawTitle) {
      const allTitles = titleWin.match(/"title"\s*:\s*"([^"]{1,60}?)\s*[-—–]\s*百度百科"/g)
      if (allTitles?.length) rawTitle = readJsonString(titleWin, titleWin.indexOf(allTitles[0]))
    }
    // 摘要：description（实体卡，锚点后）优先，其次 abstract.abstract（概念卡，锚点前）。
    // abstract 是嵌套对象 { "abstract": "..." }，外层键的值是 '{'（非字符串），
    // 故遍历所有 "abstract" 位置，取第一个读出来是中文长串的。
    const descPos = summaryWin.indexOf('"description"')
    let rawSummary = descPos >= 0 ? readJsonString(summaryWin, descPos) : ''
    if (!rawSummary) {
      let pos = -1
      while ((pos = summaryWin.indexOf('"abstract"', pos + 1)) >= 0) {
        const candidate = readJsonString(summaryWin, pos)
        if (candidate && /[\u4e00-\u9fa5]{10,}/.test(cleanBaikeText(candidate))) {
          rawSummary = candidate
          break
        }
      }
    }

    if (!rawSummary) continue
    const summary = cleanBaikeText(rawSummary)
    // 摘要必须有足够中文正文，避免抓到导航/空字段。中文被标点打断，统计全部中文字符数。
    const cjkCount = (summary.match(/[\u4e00-\u9fa5]/g) ?? []).length
    if (cjkCount < 12) continue
    const title = rawTitle ? cleanBaikeText(rawTitle) : ''
    // 词条链接（可选）：卡片附近的 baike.baidu.com/item/...
    const urlMatch = /https?:\/\/baike\.baidu\.com\/item\/[^"\s]+/.exec(titleWin + summaryWin)

    return {
      title,
      summary,
      ...(urlMatch ? { url: urlMatch[0].replace(/\\u002F/gi, '/') } : {}),
    }
  }
  return null
}

export function createBaiduBaikeSource(): BaikeSource {
  return {
    name: 'baidu-search',
    async fetch(query: string, fetcher: BaikeFetcher): Promise<BaikeEntry | null> {
      const q = query.trim()
      if (!q) return null
      const url = `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`
      const res = await fetcher(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      })
      if (!res.ok) return null
      const html = await res.text()
      return parseBaikeHtml(html)
    },
  }
}
