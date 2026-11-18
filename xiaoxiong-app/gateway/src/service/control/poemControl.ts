/**
 * 诗词/古文朗读意图的确定性识别：命中后绕开大模型，直接走 edu 数据源
 * （百度汉语原文 + 百度朗读音频），不让 LLM 自己背全文。
 *
 * 触发词（用户确认）：背诵 / 朗诵 / 念一下 / 念一段 / 读一下 / 读一读 / 吟诵 / 吟一首 / 背一下 / 背首。
 * 作品名取触发词之后的片段（「背诵滕王阁序」→「滕王阁序」，「朗诵一下王勃的滕王阁序」→「王勃的滕王阁序」）。
 * 必须有明确作品名才命中——纯「背诵」不命中（提示用户说背哪首）。
 * 不碰无朗读动词的泛问法（「滕王阁序是什么意思」交 LLM）。
 *
 * 与百科互斥：百科触发词是「百科/事迹/介绍」，诗词是「背诵/朗诵/念/读」，互不重叠；
 * 放在 handleDirectCommand 里百科之后、音乐之前即可。
 */

/** 朗读动词触发词，长词在前保证最长匹配。 */
const RECITE_SIGNALS = [
  '朗诵一下', '朗诵一段', '背诵一下', '背一下', '念一下', '念一段', '读一下', '读一读',
  '吟诵', '吟一首', '朗诵', '背诵', '背首', '念首', '吟一首', '读一读',
].sort((a, b) => b.length - a.length)
const RECITE_RE = new RegExp(RECITE_SIGNALS.join('|'), 'i')

/** 音乐/其它内容强特征：命中则不是诗词朗读（如「念出3首周杰伦的歌」是点歌） */
const OTHER_CONTENT = /的歌|歌曲|音乐|专辑|首歌|唱歌|歌词|评书|相声|有声书|新闻|天气预报|电影|电视剧|综艺|背单词/

/** 口语噪声词：从作品名头部剥掉。 */
const FILLERS = ['一下', '一段', '一首', '给我', '帮我', '麻烦', '来', '要', '把', '的', '了', '吧', '啊']

/**
 * ASR 噪声字：咳嗽/清嗓/犹豫常被识别成这些单字，夹在作品名里会污染搜索词
 * （如「背诵嗯嗯回乡偶书」「咳背诵静夜思」「滕嗯王阁序」）。
 * 它们在诗词名里几乎不会作为实义字出现（「啊」「哦」偶见但极罕见），统一剥掉。
 */
const ASR_NOISE_CHARS = /[嗯呃额噢欸咳漱咳咳呵嘶嘘哈嘿呃唉]/g
/** 开头犹豫/口头禅：用户起句前的语气铺垫。 */
const LEADING_FILLER = /^(那个|就是说|然后|嗯+|额+|呃+|咳+|啊+|哦+|所以|呃那个)+/

function strip(raw: string): string {
  let s = raw.trim()
  // 剥掉句中/首尾被 ASR 误识别进来的咳嗽、犹豫字（如「嗯嗯回乡偶书」「滕嗯王阁序」）
  s = s.replace(ASR_NOISE_CHARS, '')
  s = s.replace(LEADING_FILLER, '')
  // 折叠连续重复字（ASR 对咳嗽/结巴常输出「你你你」「嗯嗯嗯」）
  s = s.replace(/(.)\1{2,}/g, '$1')
  let changed = true
  while (changed) {
    changed = false
    for (const f of FILLERS) {
      if (s.startsWith(f)) { s = s.slice(f.length).trim(); changed = true }
    }
  }
  return s.replace(/^[，,。.、"'“”‘’\s]+|[，,。.、"'“”‘’，,？?！!]+$/g, '').trim()
}

export interface PoemCommand {
  /** 作品名（可带作者，如「王勃的滕王阁序」）；null=无话题 */
  title: string | null
}

/**
 * 文本是否为诗词朗读意图。非诗词句返回 null，交回 handleDirectCommand 后续分支。
 */
export function detectPoemCommand(text: string): PoemCommand | null {
  const t = (text || '').trim()
  if (!t) return null
  if (OTHER_CONTENT.test(t)) return null // 点歌等内容不劫持
  const m = RECITE_RE.exec(t)
  if (!m) return null
  // 取触发词之后的片段作作品名；触发词之前一般是空的（「背诵X」），有则用之前（「X 背诵一下」少见）
  const after = t.slice(m.index + m[0].length)
  // 在第一个中文标点处截断：ASR 常把多句连成一句（「背诵回乡偶书，给我回答没有书的好价」），
  // 逗号后是另一条指令，不是作品名。取第一段即可。
  const firstClause = after.split(/[，,。.！!？?；;、\s]+/)[0] ?? ''
  // ASR 连读时指令词可能紧跟作品名且逗号落在更后面（「背诵回乡偶书给我回答，没有书的好价」），
  // 这类指令动词不会出现在诗词名里，遇到就截断。
  const beforeInstruction = firstClause.split(/给我|帮我|回答|告诉|查一下|查查|搜索|找一下|麻烦你|请你|你说|的好价/)[0] ?? ''
  let title = strip(beforeInstruction || firstClause)
  // 作品名兜底长度：诗词/古文名一般 ≤15 字，超长说明 ASR 连读未断句，截断避免把整句当书名。
  if (title.length > 15) title = title.slice(0, 15)
  if (!title) {
    // 触发词在句尾（如「这首背诵一下」）：取触发词之前
    title = strip(t.slice(0, m.index))
  }
  if (!title) return { title: null } // 纯「背诵」→ 提示用户说背哪首
  return { title }
}
