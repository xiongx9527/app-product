/**
 * 百科查询意图的确定性识别：命中后绕开大模型，直接抓百科词条摘要显示+口播。
 *
 * 触发词（用户确认）：百科 / 百度百科 / 事迹 / 人物传 / 人物传记 / 人物介绍 / 人物生平
 *   / 生平 / 历史事件 / 介绍下 / 介绍一下 / 科普下 / 科普一下 / 讲讲 / 说说（及英文 wiki / encyclopedia / biography）。
 * 「介绍下XX」「讲讲XX」「XX的历史事件」都命中，但只有带明确话题词才算——纯「介绍下」不命中。
 * 不碰「什么是XX / XX是什么」这类无动词泛问法（交给 LLM 综合回答）。
 *
 * 话题词：从「XX的百科 / 百科XX / XX的事迹 / 讲讲XX / 介绍下XX」里取 XX。
 * 纯「百科 / 查百科」无话题 → keyword=null（提示用户说要查谁，不做无意义搜索）。
 *
 * 与其它直连互斥：放在 handleDirectCommand 里好价/其它查询之前——
 * 「查百科」含「查」会被好价误中；但「XX的事迹」无播放词，与音乐不冲突。
 */

/**
 * 名词型触发词：真正的百科边界词，话题通常紧邻其前/后。长词在前，保证最长匹配。
 */
const NOUN_SIGNALS = [
  '百度百科', '百科', '人物传记', '人物介绍', '人物生平', '人物传', '历史事件', '事迹', '生平',
  'encyclopedia', 'biography', 'wiki',
].sort((a, b) => b.length - a.length)

/** 动词型触发词：仅引导，无名词时也命中，但必须带话题词。 */
const VERB_SIGNALS = ['介绍一下', '介绍下', '科普一下', '科普下', '讲一下', '讲讲', '说说'].sort((a, b) => b.length - a.length)

const ALL_SIGNALS = [...NOUN_SIGNALS, ...VERB_SIGNALS]
const BAIKE_SIGNAL = new RegExp(ALL_SIGNALS.join('|'), 'i')

/** 其它内容强特征：命中则不是百科意图，交回下游（不与音乐/影视/新闻抢）。 */
const OTHER_CONTENT = /歌曲|音乐|专辑|首歌|唱歌|主题曲|歌词|评书|相声|有声书|新闻|资讯|天气预报|电影|电视剧|综艺/

/** 口语噪声词：循环从话题词头部剥掉（长词在前）。 */
const FILLER_WORDS = [
  '科普一下', '介绍一下', '查询一下', '搜索一下', '查一下', '讲一下', '搜一下', '讲讲',
  '说说', '查查', '搜搜', '科普下', '科普', '介绍', '查询', '搜索', '播放', '放一下', '看看',
  '给我', '读一下', '我想了解', '我想知道', '我想听', '我想看', '放', '查', '搜',
  '讲', '说', '读', '来点', '来', '要', '关于', '一下', '的', '个', '些', '再',
]

function stripFillers(raw: string): string {
  let s = raw.trim()
  let changed = true
  while (changed) {
    changed = false
    for (const w of FILLER_WORDS) {
      if (s.startsWith(w)) {
        s = s.slice(w.length).trim()
        changed = true
      }
    }
  }
  return s
}

/** 剥完噪声后只剩这些泛词即视为无话题。 */
const GENERIC_TOPIC = /^(百科|百度百科|事迹|人物传|人物传记|人物介绍|人物生平|生平|历史事件|介绍一下|介绍下|科普一下|科普下|讲一下|讲讲|说说|wiki|encyclopedia|biography)$/i

/** 找触发词在句中的位置：位置最靠前，同位置取最长。 */
function findSignal(lower: string, signals: string[]): { index: number; len: number } | null {
  let best: { index: number; len: number } | null = null
  for (const sig of signals) {
    const i = lower.indexOf(sig.toLowerCase())
    if (i >= 0 && (!best || i < best.index || (i === best.index && sig.length > best.len))) {
      best = { index: i, len: sig.length }
    }
  }
  return best
}

/**
 * 话题词提取：
 * 优先找名词型触发词（真正的百科边界），没有再用动词型。
 * 取触发词左边的片段作话题（「XX的百科」→「XX的」），左边为空则取右边（「百科XX」→「XX」）。
 */
function extractKeyword(t: string): string | null {
  const lower = t.toLowerCase()
  const hit = findSignal(lower, NOUN_SIGNALS) ?? findSignal(lower, VERB_SIGNALS)
  if (!hit) return null

  const left = t.slice(0, hit.index)
  const right = t.slice(hit.index + hit.len)
  let raw = left.trim() ? stripFillers(left) : right.trim() ? stripFillers(right) : ''

  // 剥尾部结构助词/语气词、引号、标点
  raw = raw.replace(/(?:的|啊|呢|呀|吧)+$/, '').trim()
  raw = raw.replace(/^[，,。.、"'“”‘’\s]+|[，,。.、"'“”‘’，,？?！!]+$/g, '').trim()
  if (!raw || GENERIC_TOPIC.test(raw) || raw.length > 20) return null
  return raw
}

export interface BaikeCommand {
  /** null = 无话题（如纯「百科」，提示用户说查谁）；非 null = 要查的人物/词条名 */
  keyword: string | null
}

/** 文本是否为百科查询意图。非百科句返回 null，交回 handleDirectCommand 后续分支。 */
export function detectBaikeCommand(text: string): BaikeCommand | null {
  const t = (text || '').trim()
  if (!t || !BAIKE_SIGNAL.test(t)) return null
  if (OTHER_CONTENT.test(t)) return null
  const keyword = extractKeyword(t)
  // 动词型触发词（介绍下/科普下/讲讲/说说）若没有话题词，不算百科意图（如纯「介绍下」），交回 LLM；
  // 名词型触发词（百科/事迹…）无话题是合法泛问，返回 {keyword:null} 由调用方提示用户。
  if (!keyword) {
    const verbOnly = t.replace(/介绍一下|介绍下|科普一下|科普下|讲一下|讲讲|说说/g, '').replace(/[\s，,。.？?！!~～]+/g, '')
    if (!verbOnly) return null
  }
  return { keyword }
}
