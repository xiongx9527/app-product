/**
 * 百度百科数据源（默认源，无 api-key）：抓百度搜索结果页，从结果 JSON 里取「百度百科」卡片的摘要。
 *
 * 为什么抓搜索页而不是词条页：
 * - 词条页 https://baike.baidu.com/item/XXX 有百度安全验证（403），服务端/设备内都过不去；
 * - 搜索结果 https://www.baidu.com/s?wd=XXX 正常返回（200），且 JSON 里自带百科卡片摘要：
 *   - 人物/实体卡：字段 `description`，标题在 `tools.title`；
 *   - 概念卡：字段 `abstract.abstract`，标题在 `character.title` / `tts.title`；
 *   - 新版头图知识卡（刘备/李白等人物词条）：摘要 `summaryData`，标题 `headProps.title.text`，
 *     卡片边界是 `"baikeText":"百度百科"`（没有 source / description / abstract 字段）。
 *   三种卡片都有明确的百科标记锚点，摘要含 <em> 高亮标签需清洗。
 *
 * 摘要用局部正则抓取而非整块 JSON.parse：这些字段嵌在搜索页一个巨大的 JSON 对象里，
 * 整块 parse 拿不到；局部字段正则对三种卡片都稳定（见 baiduBaikeSource.test.ts）。
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

/** 卡片类型：新版头图知识卡（peak）/ 旧版实体卡 / 旧版概念卡。 */
interface BaikeCardAnchor {
  index: number
  kind: 'peak' | 'entity' | 'concept'
}

/**
 * 找页面里所有「百度百科卡片」锚点，按出现位置排序。三种卡片边界：
 * - peak：新版头图知识卡 `"baikeText":"百度百科"`（刘备/李白这类人物词条走这种，
 *   摘要不在 description/abstract 里，而在 `"summaryData"`）
 * - entity：普通结果卡 `"source":"百度百科"`
 * - concept：概念卡 `"source":{"title":"百度百科"}`
 * 百度改版不通知就换卡片形态，故三种都要认——缺一种就整类词条「暂时没查到」。
 */
function findCardAnchors(html: string): BaikeCardAnchor[] {
  const anchors: BaikeCardAnchor[] = []
  for (const m of html.matchAll(/"source"\s*:\s*"百度百科"/g)) {
    anchors.push({ index: m.index ?? 0, kind: 'entity' })
  }
  for (const m of html.matchAll(/"source"\s*:\s*\{[^}]{0,200}?"title"\s*:\s*"百度百科"/g)) {
    anchors.push({ index: m.index ?? 0, kind: 'concept' })
  }
  for (const m of html.matchAll(/"baikeText"\s*:\s*"百度百科"/g)) {
    anchors.push({ index: m.index ?? 0, kind: 'peak' })
  }
  return anchors.sort((a, b) => a.index - b.index)
}

/** 新版头图卡标题在 headProps.title.text（`cardData.name` 兜底）。 */
function peakCardTitle(win: string): string {
  const hp = win.indexOf('"headProps"')
  if (hp >= 0) {
    const titleKey = win.indexOf('"title"', hp)
    const textKey = titleKey >= 0 ? win.indexOf('"text"', titleKey) : -1
    if (textKey >= 0) {
      const t = readJsonString(win, textKey)
      if (t) return t
    }
  }
  const cd = win.indexOf('"cardData"')
  const nameKey = cd >= 0 ? win.indexOf('"name"', cd) : -1
  return nameKey >= 0 ? readJsonString(win, nameKey) : ''
}

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
 * 提取百科卡片配图：卡片里的 poster 形如
 *   "poster":"https://gimg3.baidu.com/topone/src=https%3A%2F%2Fbkimg.cdn.bcebos.com%2F...%3Fx-bce-process%3D..."
 * 外壳 gimg3.baidu.com 的 src 参数是 URL 编码过的 bkimg 直链，带时效签名会过期；
 * 解码出内层 bkimg.cdn.bcebos.com 直链（无时效签名、实测直连 200）才是稳定封面。
 * 取卡片窗口内第一个 bkimg.cdn.bcebos.com 的 poster。
 */
function extractBaikeImage(win: string): string | undefined {
  const matches = [...win.matchAll(/"poster"\s*:\s*"/g)]
  if (!matches.length) return undefined
  for (const m of matches) {
    // m.index 指向 `"poster"` 的起始引号，readJsonString 从字段名起始引号读值
    const raw = readJsonString(win, m.index ?? 0)
    if (!raw) continue
    // gimg 外壳里 src 是路径段（/topone/src=...）或查询参数（?src=...），两种都要认
    const srcMatch = /(?:[?&/])src=([^&]+)/.exec(raw)
    if (!srcMatch) continue
    let inner: string
    try {
      inner = decodeURIComponent(srcMatch[1])
    } catch {
      continue
    }
    // 只接受稳定的百度百科图床直链，避免把带时效签名的 gimg 外壳或别的域名下发
    if (/^https:\/\/bkimg\.cdn\.bcebos\.com\//.test(inner)) return inner
  }
  return undefined
}

/**
 * 从百度搜索结果页 HTML 里解析百科卡片，纯函数便于单测。
 * 取第一个含中文摘要的「百度百科」卡片；没有返回 null。
 */
export function parseBaikeHtml(html: string): BaikeEntry | null {
  const anchors = findCardAnchors(html)
  for (let ai = 0; ai < anchors.length; ai++) {
    const { index: idx, kind } = anchors[ai]
    const nextIdx = ai + 1 < anchors.length ? anchors[ai + 1].index : html.length
    // 摘要可能在本卡锚点之前（概念卡的 abstract / 头图卡的 summaryData）或之后（实体卡的
    // description）；标题也在锚点前或后。头图卡整块更大（cardData + 目录），回看窗口放宽。
    // 两块都向后截到下一锚点前，避免串入相邻卡片。
    const backFrom = Math.max(0, idx - (kind === 'peak' ? 14000 : 9000))
    const endAt = Math.min(nextIdx, idx + 2000)
    const win = html.slice(backFrom, endAt)
    // 配图 poster 可能比摘要更靠前（实测比锚点早 9.5k，超出 entity 的 9k 窗口），
    // 用独立更大的回看窗口提取，不影响标题/摘要既有窗口与解析。
    const imageWin = html.slice(Math.max(0, idx - 16000), endAt)

    // 标题：头图卡读 headProps.title.text；旧卡 tools.title → character.title → kgTitlePlain
    let rawTitle = kind === 'peak' ? peakCardTitle(win) : ''
    if (!rawTitle) {
      const toolsPos = win.indexOf('"tools"')
      if (toolsPos >= 0) {
        const tp = win.indexOf('"title"', toolsPos)
        if (tp >= 0) rawTitle = readJsonString(win, tp)
      }
    }
    if (!rawTitle) {
      const charPos = win.indexOf('"character"')
      const ct = charPos >= 0 ? win.indexOf('"title"', charPos) : -1
      if (ct >= 0) rawTitle = readJsonString(win, ct)
    }
    if (!rawTitle) {
      const kt = win.indexOf('"kgTitlePlain"')
      if (kt >= 0) rawTitle = readJsonString(win, kt)
    }
    // 兜底：搜索卡片里形如 "title":"XX - 百度百科" 的标题
    if (!rawTitle) {
      const allTitles = win.match(/"title"\s*:\s*"([^"]{1,60}?)\s*[-—–]\s*百度百科"/g)
      if (allTitles?.length) rawTitle = readJsonString(win, win.indexOf(allTitles[0]))
    }

    // 摘要：头图卡只有 summaryData；旧卡 description（锚点后）优先，其次 abstract（锚点前）。
    // abstract 是嵌套对象 { "abstract": "..." }，外层键的值是 '{'（非字符串），
    // 故遍历所有 "abstract" 位置，取第一个读出来是中文长串的。
    // 头图卡里也有短 abstract（如「三国时期蜀汉开国皇帝」），不能用它当摘要——太短会被丢弃。
    let rawSummary = ''
    if (kind === 'peak') {
      const sd = win.indexOf('"summaryData"')
      if (sd >= 0) rawSummary = readJsonString(win, sd)
    } else {
      const descPos = win.indexOf('"description"')
      rawSummary = descPos >= 0 ? readJsonString(win, descPos) : ''
      if (!rawSummary) {
        let pos = -1
        while ((pos = win.indexOf('"abstract"', pos + 1)) >= 0) {
          const candidate = readJsonString(win, pos)
          if (candidate && /[\u4e00-\u9fa5]{10,}/.test(cleanBaikeText(candidate))) {
            rawSummary = candidate
            break
          }
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
    const urlMatch = /https?:\/\/baike\.baidu\.com\/item\/[^"\s]+/.exec(win)
    // 词条配图（可选）：解码 poster 里的 bkimg 稳定直链
    const image = extractBaikeImage(imageWin)

    return {
      title,
      summary,
      ...(urlMatch ? { url: urlMatch[0].replace(/\\u002F/gi, '/') } : {}),
      ...(image ? { image } : {}),
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
