/**
 * 时间类高置信意图的确定性识别：命中后绕开大模型，直接用网关本地时钟口播。
 * 用户反馈「问现在几点了为啥还走大模型、好慢」——这类问题答案确定、无需 LLM，
 * 按 AGENTS.md「少调 LLM：高置信控制指令直连绕开大模型」直接落地。
 * 只拦明确问时间/日期的句子；含糊的「时间都去哪了」等不拦，交后续逻辑。
 * 识别细分三态：问时间（几点）/ 问日期（星期几、几月几号）/ 两样都问——
 * 「今天星期几」只报时分不报日期是漏答，日期类必须给全「X年X月X日 星期X」。
 */

/** 问时间：答案只是时:分 */
const TIME_WORDS = /几点|几时|报时|现在时间|当前时间|什么时间|什么时刻/

/** 问日期：答案含年月日 / 星期 */
const DATE_WORDS =
  /几号|几月几[号日]|什么日期|什么日子|星期几|周几|礼拜几|今天几号|今天是[星期周几]|日历/

export type TimeIntentKind = 'time' | 'date' | 'both'

/** 识别时间/日期意图：null 表示不是这类句子；'both' 表示一句里时间、日期都问了。 */
export function detectTimeCommandKind(text: string): TimeIntentKind | null {
  const t = text.trim()
  if (!t) return null
  const time = TIME_WORDS.test(t)
  const date = DATE_WORDS.test(t)
  if (time && date) return 'both'
  if (time) return 'time'
  if (date) return 'date'
  return null
}

/** 文本是否为「问现在几点 / 今天几号 / 星期几」这类时间查询。 */
export function detectTimeCommand(text: string): boolean {
  return detectTimeCommandKind(text) !== null
}
