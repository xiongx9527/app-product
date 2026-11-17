/**
 * 新闻播报意图的确定性识别：命中后绕开大模型，直接走百度新闻频道抓 headlines 口播。
 *
 * 触发词：新闻 / 消息 / 头条 / 热点 / 快讯（及英文 news/headlines）。
 * 「新闻/消息」是用户明确要加的关键词；「最新消息」里的「消息」也算新闻语境（不是即时通讯）。
 *
 * 话题词：形如「科技新闻」「关于科技的新闻」「科技最新消息」取触发词前的片段作 keyword；
 * 「播放新闻 / 新闻 / 最新消息 / 今天的新闻」这类只泛播当日头条，keyword=null。
 *
 * 与其它直连命令互斥：本检测放在 handleDirectCommand 里音乐分支之前——
 * musicControl 的 play 正则含裸「播放/放」，「播放新闻」否则会被当点歌。
 * 记忆类「消息」由更靠前的 detectMemoryCommand 先消费，这里不必重复处理。
 */

/** 触发词。不带 /g，避免 test() 的 lastIndex 状态问题。 */
const NEWS_SIGNAL = /新闻|消息|头条|热点|快讯|news|headlines?/i

/** 其它内容强特征：命中则不是新闻意图，交回下游（不与音乐/影视/曲艺抢） */
const OTHER_CONTENT = /歌曲|音乐|专辑|首歌|唱歌|评书|相声|有声书|电影|电视剧|动画片|综艺/

/** 口语噪声词：循环从话题词头部剥掉，剩下的才是可能的话题词 */
const FILLER_WORDS = [
  '播放', '放一下', '放', '搜一下', '搜', '查一下', '查询', '查', '看看', '给我',
  '来点', '来', '播报', '读一下', '读', '说', '要', '我想听', '我想看', '再',
  '有什么', '有啥', '一下', '点', '个', '些', '今天', '今日', '最近', '最新',
  '近期', '此刻', '现在', '的',
]

/** 循环剥掉头部口语噪声（「再放个科技」→「科技」；「今天有什么」→「」） */
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

/** 剥完噪声后只剩这些泛词即视为无话题（泛播） */
const GENERIC_TOPIC = /^(新闻|消息|头条|热点|快讯|最新|今天|今日|最近|近期|一些|点|个|再|news|headlines?)$/i

/** 话题词提取：从「XX的新闻 / XX最新消息 / XX新闻」里取 XX。 */
function extractKeyword(t: string): string | null {
  // 触发词前的最长片段（贪婪到最后一个触发词之前），如「关于科技的新闻」→「关于科技」
  const m = t.match(/^(.+?)(?:的)?(?:最新消息|最新新闻|新闻|消息|头条|热点|快讯|news|headlines?)\s*[？?。!！]?$/i)
  // 没匹配到（如纯「新闻」）说明触发词即整句，无话题词
  if (!m) return null
  let raw = stripFillers(m[1])
  // 去掉首尾标点/空白
  raw = raw.replace(/^[，,。.、\s]+|[，,。.、\s]+$/g, '').trim()
  if (!raw || GENERIC_TOPIC.test(raw)) return null
  // 话题词不宜过长（防误把整句当话题）
  return raw.length <= 20 ? raw : null
}

export interface NewsCommand {
  /** null = 泛播当日头条；非 null = 话题词，搜该话题的新闻 */
  keyword: string | null
}

/** 文本是否为新闻播报意图。非新闻句返回 null，交回 handleDirectCommand 后续分支。 */
export function detectNewsCommand(text: string): NewsCommand | null {
  const t = text.trim()
  if (!t || !NEWS_SIGNAL.test(t)) return null
  if (OTHER_CONTENT.test(t)) return null
  return { keyword: extractKeyword(t) }
}
